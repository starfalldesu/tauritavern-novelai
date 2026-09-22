// NovelAI Image (Direct) — SillyTavern / TauriTavern 第三方扩展
//
// 背景：TauriTavern 手机版删掉了「API 连接 → NovelAI」填 token 的入口，且后端没有
//       /api/novelai/generate-image 路由。而内置「图像生成 → NovelAI」来源的生图请求
//       恰好打在这条缺失路由上，导致能选 NovelAI 却生成失败。
//
// 本扩展的思路（自包含，无需改 Rust 后端）：
//   1. 在「图像生成 → NovelAI」设置区注入持久 token（pst-...）输入框 + 诊断按钮。
//   2. 拦截内置 stable-diffusion 扩展发往 /api/novelai/generate-image 的 fetch，
//      用用户填写的 token 直连 NovelAI 官方接口 https://image.novelai.net/ai/generate-image。
//   3. 请求体完全复刻 SillyTavern 官方服务端 src/endpoints/novelai.js 的实现
//      （含 v4_prompt / characterPrompts / skip_cfg_above_sigma 等严格 schema 字段），
//      以兼容 V3/V4/V4.5 全系列模型。
//   4. NovelAI 返回的是 ZIP 压缩包，此处解包提取 PNG 并转 base64，按内置扩展期望的
//      {ok, text()} 形式回传，UI 与流程完全不变。
//
// 若手机 WebView 因 CORS 拦截直连 NovelAI（诊断按钮可一键判定），可把设置区的
// 「生图 API 地址」「账户 API 地址」改为自建反向代理地址。
//
// 兼容：TauriTavern 与标准 SillyTavern 均可使用。

// 注意：第三方扩展位于 /scripts/extensions/third-party/<name>/，比内置扩展深一级，
//       因此 script.js 需要 4 级 ../（→ /script.js），extensions.js 需要 3 级（→ /scripts/extensions.js）。
import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';

// 在包装 window.fetch 之前保存原始引用，转发真实请求时使用，避免递归。
// 注意：TauriTavern 自身也会 patch fetch 做本地路由，我们包在它外层；
// 对外部 URL 它会原样放行（delegateFetch），因此行为与原生 fetch 一致。
const originalFetch = (typeof window !== 'undefined' && typeof window.fetch === 'function')
    ? window.fetch.bind(window)
    : globalThis.fetch.bind(globalThis);

const NAMESPACE = 'tt_novelai_image';
const GENERATE_PATH_SUFFIX = 'api/novelai/generate-image';

// ---------- 设置 ----------

function baseSettings() {
    return {
        persistentToken: '',
        imageUrl: 'https://image.novelai.net',
        accountUrl: 'https://api.novelai.net',
    };
}

function getSettings() {
    if (!extension_settings.sd) {
        extension_settings.sd = {};
    }
    if (!extension_settings.sd[NAMESPACE]) {
        extension_settings.sd[NAMESPACE] = baseSettings();
    }
    return extension_settings.sd[NAMESPACE];
}

// ---------- 工具 ----------

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, max = 400) {
    const s = String(text || '').trim();
    return s.length > max ? s.slice(0, max) + '…' : s;
}

// 构造内置 generateNovelImage 兼容的响应对象（它只使用 ok / status / text()）。
function fakeResponse(status, bodyText) {
    const ok = status >= 200 && status < 300;
    return {
        ok: ok,
        status: status,
        statusText: ok ? 'OK' : 'Error',
        async text() { return bodyText; },
        async json() { return JSON.parse(bodyText); },
        clone() { return fakeResponse(status, bodyText); },
        headers: new Headers(),
    };
}

// ---------- ZIP 解包：提取第一个 .png ----------
// NovelAI 的 /ai/generate-image 无论几张图都返回 ZIP。这里通过 EOCD 定位
// central directory，再定位第一个 PNG 条目的本地数据区并解压。

function readU16(bytes, offset) {
    return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes, offset) {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

async function inflateRaw(compBytes) {
    if (typeof DecompressionStream === 'undefined') {
        throw new Error('当前 WebView 不支持 DecompressionStream，无法解压返回的 ZIP。');
    }
    const stream = new Blob([compBytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function extractPngFromZip(buffer) {
    const bytes = new Uint8Array(buffer);

    // 从尾部向前查找 EOCD 记录（PK\x05\x06）
    let eocd = -1;
    const scanStart = Math.max(0, bytes.length - 65557);
    for (let i = bytes.length - 22; i >= scanStart; i--) {
        if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) {
        throw new Error('NovelAI 返回的数据不是有效的 ZIP。');
    }

    const cdOffset = readU32(bytes, eocd + 16);
    const entries = readU16(bytes, eocd + 10);

    // 遍历 central directory，找到第一个 .png 条目
    let ptr = cdOffset;
    for (let idx = 0; idx < entries; idx++) {
        if (ptr + 46 > bytes.length || readU32(bytes, ptr) !== 0x02014b50) {
            break;
        }
        const method = readU16(bytes, ptr + 10);
        const compressedSize = readU32(bytes, ptr + 20);
        const filenameLen = readU16(bytes, ptr + 28);
        const extraLen = readU16(bytes, ptr + 30);
        const commentLen = readU16(bytes, ptr + 32);
        const localOffset = readU32(bytes, ptr + 42);
        const filename = String.fromCharCode(...bytes.subarray(ptr + 46, ptr + 46 + filenameLen)).toLowerCase();

        if (filename.endsWith('.png') || filename.endsWith('.jpg') || filename.endsWith('.jpeg')) {
            // 本地文件头：30 字节 + 文件名 + 附加字段，之后是压缩数据
            const localNameLen = readU16(bytes, localOffset + 26);
            const localExtraLen = readU16(bytes, localOffset + 28);
            const dataStart = localOffset + 30 + localNameLen + localExtraLen;
            const compBytes = bytes.subarray(dataStart, dataStart + compressedSize);

            const raw = method === 0 ? compBytes : await inflateRaw(compBytes);

            // 校验 PNG 魔数（不匹配也原样返回，交给上层显示）
            if (!(raw[0] === 0x89 && raw[1] === 0x50 && raw[2] === 0x4e && raw[3] === 0x47)) {
                throw new Error('ZIP 中未找到有效的 PNG 数据。');
            }
            return raw;
        }

        ptr += 46 + filenameLen + extraLen + commentLen;
    }

    throw new Error('NovelAI 的 ZIP 响应中没有找到图像文件。');
}

// 分块转 base64，避免大图导致 String.fromCharCode 参数超限。
function bytesToBase64(bytes) {
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

// ---------- 请求体构造（复刻 SillyTavern 官方 novelai.js）----------

const REFERENCE_PIXEL_COUNT = 1011712;   // 832 * 1216
const SIGMA_MAGIC_NUMBER = 19;            // V3/V4 variety_boost 基准
const SIGMA_MAGIC_NUMBER_V4_5 = 58;      // V4.5 variety_boost 基准

function calculateSkipCfgAboveSigma(width, height, modelName) {
    const magicConstant = String(modelName || '').includes('nai-diffusion-4-5')
        ? SIGMA_MAGIC_NUMBER_V4_5
        : SIGMA_MAGIC_NUMBER;
    const ratio = (width * height) / REFERENCE_PIXEL_COUNT;
    return Math.pow(ratio, 0.5) * magicConstant;
}

function buildNovelPayload(body) {
    const prompt = String(body.prompt ?? '');
    const uc = String(body.negative_prompt ?? '');
    const model = String(body.model ?? 'nai-diffusion-3');
    const width = Math.max(64, Math.floor(Number(body.width) || 512));
    const height = Math.max(64, Math.floor(Number(body.height) || 512));
    const steps = Math.min(50, Math.max(1, Math.floor(Number(body.steps) || 28)));
    const scale = Number(body.scale) || 5.0;

    // NovelAI 的 seed 为无符号 32 位整数；未指定时随机生成
    let seed = Math.floor(Number(body.seed));
    if (!Number.isFinite(seed) || seed < 0) {
        seed = Math.floor(Math.random() * 4294967296);
    } else {
        seed = seed % 4294967296;
    }

    return {
        action: 'generate',
        input: prompt,
        model: model,
        parameters: {
            params_version: 3,
            prefer_brownian: true,
            negative_prompt: uc,
            height: height,
            width: width,
            scale: scale,
            seed: seed,
            sampler: String(body.sampler ?? 'k_euler_ancestral'),
            noise_schedule: String(body.scheduler ?? 'karras'),
            steps: steps,
            n_samples: 1,
            // NAI handholding for prompts
            ucPreset: 0,
            qualityToggle: false,
            add_original_image: false,
            controlnet_strength: 1,
            deliberate_euler_ancestral_bug: false,
            dynamic_thresholding: !!body.decrisper,
            legacy: false,
            legacy_v3_extend: false,
            sm: !!body.sm,
            sm_dyn: !!body.sm_dyn,
            uncond_scale: 1,
            skip_cfg_above_sigma: body.variety_boost
                ? calculateSkipCfgAboveSigma(width, height, model)
                : null,
            use_coords: false,
            characterPrompts: [],
            reference_image_multiple: [],
            reference_information_extracted_multiple: [],
            reference_strength_multiple: [],
            v4_negative_prompt: {
                caption: {
                    base_caption: uc,
                    char_captions: [],
                },
            },
            v4_prompt: {
                caption: {
                    base_caption: prompt,
                    char_captions: [],
                },
                use_coords: false,
                use_order: true,
            },
        },
    };
}

// ---------- 生成处理 ----------

async function handleNovelGeneration(body, init) {
    const settings = getSettings();
    const token = String(settings.persistentToken || '').trim();
    if (!token) {
        return fakeResponse(401,
            'NovelAI 插件：尚未填写持久 token。请打开「扩展 → 图像生成 → NovelAI」，在「NovelAI 持久 Token (Plugin)」中填入 pst-... 开头的 token 并保存。');
    }

    const url = String(settings.imageUrl || 'https://image.novelai.net').replace(/\/+$/, '') + '/ai/generate-image';
    const payload = buildNovelPayload(body);

    let response;
    try {
        response = await originalFetch(url, {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + token,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
            credentials: 'omit',
            signal: init && init.signal ? init.signal : undefined,
        });
    } catch (err) {
        return fakeResponse(0,
            '无法连接 NovelAI 生图接口（' + url + '）：' + shorten((err && err.message) || String(err))
            + '。这通常由 CORS 跨域拦截或网络不可达导致，可点击本设置区的「校验」按钮诊断，或在「生图 API 地址」中改用反向代理。');
    }

    if (!response.ok) {
        let message = await response.text();
        try {
            const parsed = JSON.parse(message);
            message = parsed.message || parsed.error || message;
        } catch { /* 保留原文 */ }
        return fakeResponse(response.status, 'NovelAI API ' + response.status + ': ' + shorten(message));
    }

    try {
        const buffer = await response.arrayBuffer();
        const png = await extractPngFromZip(buffer);
        return fakeResponse(200, bytesToBase64(png));
    } catch (err) {
        return fakeResponse(500, '解析 NovelAI 返回数据失败：' + shorten((err && err.message) || String(err)));
    }
}

// ---------- fetch 拦截 ----------

function installFetchInterceptor() {
    if (typeof window === 'undefined' || typeof window.fetch !== 'function') {
        return;
    }
    if (window.__ttNovelaiImagePatched) {
        return;
    }
    window.__ttNovelaiImagePatched = true;

    window.fetch = function (input, init) {
        const url = (typeof input === 'string')
            ? input
            : (input && typeof input.url === 'string') ? input.url : '';

        const path = String(url).split('?')[0].replace(/^\/+/, '');
        if (path === GENERATE_PATH_SUFFIX || path.endsWith('/' + GENERATE_PATH_SUFFIX)) {
            let body = {};
            try {
                body = JSON.parse((init && typeof init.body === 'string') ? init.body : '{}');
            } catch { /* 解析失败按空参数处理 */ }
            return handleNovelGeneration(body, init);
        }
        return originalFetch(input, init);
    };
}

// ---------- 诊断 ----------

// 校验 token（走账户 API），顺带验证账户域的跨域可用性。
async function checkSubscription() {
    const settings = getSettings();
    const token = String(settings.persistentToken || '').trim();
    if (!token) {
        return { ok: false, error: '尚未填写持久 token。' };
    }

    const url = String(settings.accountUrl || 'https://api.novelai.net').replace(/\/+$/, '') + '/user/subscription';
    try {
        const response = await originalFetch(url, {
            method: 'GET',
            headers: { 'Authorization': 'Bearer ' + token },
            credentials: 'omit',
        });
        if (!response.ok) {
            let message = await response.text();
            try {
                message = (JSON.parse(message).message) || message;
            } catch { /* 保留原文 */ }
            return { ok: false, error: 'HTTP ' + response.status + ': ' + shorten(message) };
        }
        const info = await response.json();
        const tier = info.tier || (info.subscription && info.subscription.tier) || 'none';
        return {
            ok: true,
            anlas: info.anlas_total != null ? info.anlas_total : 0,
            tier: tier,
            active: tier !== 'none',
        };
    } catch (err) {
        return { ok: false, cors: true, error: shorten((err && err.message) || String(err)) };
    }
}

// 预检探测生图域：模拟真实生图会触发的 CORS preflight（OPTIONS + 自定义头），
// resolve 即代表直连可用，reject 则需要反向代理。
async function probeImageCors() {
    const settings = getSettings();
    const token = String(settings.persistentToken || '').trim();
    const url = String(settings.imageUrl || 'https://image.novelai.net').replace(/\/+$/, '') + '/ai/generate-image';
    try {
        await originalFetch(url, {
            method: 'OPTIONS',
            headers: {
                'Authorization': 'Bearer ' + token,
                'Content-Type': 'application/json',
            },
            credentials: 'omit',
        });
        return { ok: true };
    } catch (err) {
        return { ok: false, error: shorten((err && err.message) || String(err)) };
    }
}

// ---------- 设置面板 ----------

function setStatus(el, text, isError) {
    if (!el) return;
    el.textContent = text;
    el.style.color = isError ? '#e74c3c' : '#2ecc71';
    el.style.whiteSpace = 'pre-wrap';
}

function injectSettingsPanel() {
    const panel = document.querySelector('.sd_settings [data-sd-source="novel"]');
    if (!panel) {
        return false;
    }
    if (panel.querySelector('#tt_nv_token_block')) {
        return true;
    }

    const settings = getSettings();

    const block = document.createElement('div');
    block.id = 'tt_nv_token_block';
    block.className = 'marginTopBot5';
    block.style.padding = '6px 0';
    block.style.borderTop = '1px dashed rgba(128,128,128,.4)';

    block.innerHTML = `
        <div class="flex-container justifySpaceBetween marginBot5">
            <strong>NovelAI 持久 Token (Plugin)</strong>
        </div>
        <input id="tt_nv_token" type="password" class="text_pole" placeholder="pst-..." autocomplete="off" />
        <div class="flex-container flexnowrap marginTop5">
            <div id="tt_nv_save" class="menu_button" title="保存 token">
                <i class="fa-solid fa-floppy-disk"></i>
                <span>保存</span>
            </div>
            <div id="tt_nv_check" class="menu_button" title="校验 token、订阅与生图接口连通性">
                <i class="fa-solid fa-circle-check"></i>
                <span>校验</span>
            </div>
        </div>
        <div id="tt_nv_status" class="marginTop5" style="min-height:1em;"></div>
        <label class="checkbox_label marginTop5" for="tt_nv_more">
            <input id="tt_nv_more" type="checkbox" />
            <span>高级（自定义 API 地址 / 反向代理）</span>
        </label>
        <div id="tt_nv_advanced" style="display:none;">
            <div class="marginTop5">
                <label for="tt_nv_image_url" style="font-size:0.85em;">生图 API 地址（默认 https://image.novelai.net）</label>
                <input id="tt_nv_image_url" type="text" class="text_pole" placeholder="https://image.novelai.net" />
            </div>
            <div class="marginTop5">
                <label for="tt_nv_account_url" style="font-size:0.85em;">账户 API 地址（默认 https://api.novelai.net）</label>
                <input id="tt_nv_account_url" type="text" class="text_pole" placeholder="https://api.novelai.net" />
            </div>
        </div>
        <i class="marginTop5" style="font-size:0.85em;">
            在 novelai.net 的 Account 页面生成持久 API Token（pst-... 开头）后填入。此插件由图像生成界面的 NovelAI 来源直接调用官方 API 生图。
        </i>
    `;
    panel.appendChild(block);

    const tokenInput = block.querySelector('#tt_nv_token');
    const imageUrlInput = block.querySelector('#tt_nv_image_url');
    const accountUrlInput = block.querySelector('#tt_nv_account_url');
    const advancedToggle = block.querySelector('#tt_nv_more');
    const advancedBox = block.querySelector('#tt_nv_advanced');
    const saveBtn = block.querySelector('#tt_nv_save');
    const checkBtn = block.querySelector('#tt_nv_check');
    const statusEl = block.querySelector('#tt_nv_status');

    tokenInput.value = settings.persistentToken || '';
    imageUrlInput.value = settings.imageUrl || '';
    accountUrlInput.value = settings.accountUrl || '';

    const save = () => {
        settings.persistentToken = tokenInput.value.trim();
        settings.imageUrl = imageUrlInput.value.trim() || 'https://image.novelai.net';
        settings.accountUrl = accountUrlInput.value.trim() || 'https://api.novelai.net';
        saveSettingsDebounced();
    };

    advancedToggle.addEventListener('change', () => {
        advancedBox.style.display = advancedToggle.checked ? 'block' : 'none';
    });

    saveBtn.addEventListener('click', () => {
        save();
        setStatus(statusEl, '已保存。', false);
    });

    tokenInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            saveBtn.click();
        }
    });

    checkBtn.addEventListener('click', async () => {
        save();
        setStatus(statusEl, '校验中…', false);

        const sub = await checkSubscription();
        if (!sub.ok) {
            if (sub.cors) {
                setStatus(statusEl,
                    '无法访问账户 API（' + sub.error + '）。\n可能是 CORS 拦截或网络不可达：请检查网络；仍失败则需在「高级」中把两个地址改为反向代理。',
                    true);
            } else {
                setStatus(statusEl, 'Token 校验失败：' + sub.error, true);
            }
            return;
        }

        const tierMap = { paper: 'Paper', tablet: 'Tablet', scroll: 'Scroll', opus: 'Opus', none: '无' };
        const tierName = tierMap[sub.tier] || sub.tier;
        let message = 'Token 有效。Anlas：' + sub.anlas + '　订阅：' + (sub.active ? tierName : tierName + '（未激活）');

        const probe = await probeImageCors();
        if (probe.ok) {
            setStatus(statusEl, message + '\n生图接口连通性：正常，可直接生成。', false);
        } else {
            setStatus(statusEl,
                message + '\n生图接口直连被拦截（' + probe.error + '）。\n请在「高级」中把「生图 API 地址」改为支持跨域的反向代理后重试。',
                true);
        }
    });

    // 隐藏内置的「View my Anlas」按钮：其依赖的服务器路由在 TauriTavern 中不存在。
    const builtinAnlas = panel.querySelector('#sd_novel_view_anlas');
    if (builtinAnlas) {
        builtinAnlas.style.display = 'none';
    }

    return true;
}

// ---------- 初始化 ----------

async function init() {
    try {
        installFetchInterceptor();

        // 设置面板随图像生成面板动态渲染，需轮询注入
        for (let i = 0; i < 30; i++) {
            if (injectSettingsPanel()) {
                break;
            }
            await delay(400);
        }
        if (!injectSettingsPanel()) {
            eventSource.on(event_types.APP_READY, () => {
                for (let i = 0; i < 30; i++) {
                    setTimeout(injectSettingsPanel, 400 * (i + 1));
                }
            });
        }
    } catch (e) {
        console.error('[NovelAI Image (Direct)] 初始化失败:', e);
    }
}

jQuery(init);
