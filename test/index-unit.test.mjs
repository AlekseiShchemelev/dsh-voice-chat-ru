/**
 * dsh-voice-chat 宿主半身单元自测：设置归一化、朗读前清洗、音频格式嗅探、
 * ASR 响应解析、edge-tts 令牌/SSML。
 * 全程离线：ASR 集成用例只打本地 node:http 起的假服务，edge-tts 不发网络请求。
 * 运行：node test/index-unit.test.mjs
 */
import assert from "node:assert/strict";
import http from "node:http";
import {
	buildPublicSlots,
	cleanForTts,
	detectAudioMime,
	migrateLegacySettings,
	mergeSettings,
	parseChatContent,
	parseTranscriptionText,
	resolveAsrConfig,
	resolveTtsConfig,
	resolveTtsEngine,
	sanitizeSettings,
	transcribe,
	transcribeWithChatAsr
} from "../lib/index.js";
import { buildSsml, generateSecMsGec } from "../lib/edge-tts.js";

let passed = 0;
function test(name, fn) {
	try {
		fn();
		passed += 1;
		console.log(`  ok  ${name}`);
	} catch (err) {
		console.error(`FAIL  ${name}`);
		console.error(err);
		process.exitCode = 1;
	}
}

/** 异步用例：与同步用例共用同一个 test()/计数/退出码约定。 */
function testAsync(name, fn) {
	return Promise.resolve()
		.then(fn)
		.then(() => {
			passed += 1;
			console.log(`  ok  ${name}`);
		})
		.catch((err) => {
			console.error(`FAIL  ${name}`);
			console.error(err);
			process.exitCode = 1;
		});
}

/** 12 字节起步的合法 WAV 头（只用于嗅探与 chat ASR 的入参）。 */
function wavHeader() {
	return Buffer.concat([
		Buffer.from("RIFF", "latin1"),
		Buffer.from([0x24, 0x00, 0x00, 0x00]),
		Buffer.from("WAVEfmt ", "latin1")
	]);
}

console.log("sanitizeSettings: silenceMs");
test("下限 300ms", () => {
	assert.equal(sanitizeSettings({ silenceMs: 1 }).silenceMs, 300);
	assert.equal(sanitizeSettings({ silenceMs: -5000 }).silenceMs, 300);
});
test("上限 15000ms", () => {
	assert.equal(sanitizeSettings({ silenceMs: 999999 }).silenceMs, 15000);
});
test("区间内的值与小数四舍五入", () => {
	assert.equal(sanitizeSettings({ silenceMs: 2500 }).silenceMs, 2500);
	assert.equal(sanitizeSettings({ silenceMs: 1200.6 }).silenceMs, 1201);
});
test("数字字符串按数字处理", () => {
	assert.equal(sanitizeSettings({ silenceMs: "1800" }).silenceMs, 1800);
});
test("非数字字符串视为未设置（null）", () => {
	assert.equal(sanitizeSettings({ silenceMs: "несколько" }).silenceMs, null);
});
test("null 视为未设置，不被夹成下限 300", () => {
	assert.equal(sanitizeSettings({ silenceMs: null }).silenceMs, null,
		"Number(null)=0 → 旧实现会把「清空」写成 300ms");
});
test("空串视为未设置，不被夹成下限 300", () => {
	assert.equal(sanitizeSettings({ silenceMs: "" }).silenceMs, null);
});
test("未提供的键不出现（回落到默认链）", () => {
	assert.equal("silenceMs" in sanitizeSettings({}), false);
});

console.log("\nsanitizeSettings: ratePercent");
test("夹在 50..200", () => {
	assert.equal(sanitizeSettings({ ratePercent: 0 }).ratePercent, 50);
	assert.equal(sanitizeSettings({ ratePercent: 9999 }).ratePercent, 200);
	assert.equal(sanitizeSettings({ ratePercent: 100 }).ratePercent, 100);
});
test("null/空串视为未设置，不被夹成 50", () => {
	assert.equal(sanitizeSettings({ ratePercent: null }).ratePercent, null);
	assert.equal(sanitizeSettings({ ratePercent: "" }).ratePercent, null);
});
test("非数字字符串 → null", () => {
	assert.equal(sanitizeSettings({ ratePercent: "быстро" }).ratePercent, null);
});

console.log("\nsanitizeSettings: 引擎名归一化");
test("asrEngine 大小写与空格容错", () => {
	assert.equal(sanitizeSettings({ asrEngine: "  MIMO " }).asrEngine, "mimo");
	assert.equal(sanitizeSettings({ asrEngine: "Groq" }).asrEngine, "groq");
});
test("ttsEngine 大小写与空格容错", () => {
	assert.equal(sanitizeSettings({ ttsEngine: " EDGE " }).ttsEngine, "edge");
	assert.equal(sanitizeSettings({ ttsEngine: "Custom" }).ttsEngine, "custom");
});
test("未知 asrEngine 回落 siliconflow", () => {
	assert.equal(sanitizeSettings({ asrEngine: "whisper.cpp" }).asrEngine, "siliconflow");
	assert.equal(sanitizeSettings({ asrEngine: "" }).asrEngine, "siliconflow");
});
test("未知 ttsEngine 回落 edge", () => {
	assert.equal(sanitizeSettings({ ttsEngine: "elevenlabs" }).ttsEngine, "edge");
	assert.equal(sanitizeSettings({ ttsEngine: null }).ttsEngine, "edge");
});

console.log("\nsanitizeSettings: 槽（未知引擎/未知字段被丢弃）");
test("未知引擎的槽整个丢掉", () => {
	const out = sanitizeSettings({ asr: { gemini: { apiKey: "k" } }, tts: { fish: { voice: "v" } } });
	assert.deepEqual(out.asr, {});
	assert.deepEqual(out.tts, {});
});
test("槽里的未知字段被丢掉，已知字段 trim", () => {
	const out = sanitizeSettings({ tts: { mimo: { apiKey: "  k  ", temperature: 0.7, format: "wav" } } });
	assert.deepEqual(out.tts.mimo, { apiKey: "k" });
});
test("槽里的数字按字符串保存（trim）", () => {
	const out = sanitizeSettings({ asr: { groq: { model: 123 } } });
	assert.deepEqual(out.asr.groq, { model: "123" });
});
test("槽值不是对象时退化成空槽，不抛错", () => {
	assert.deepEqual(sanitizeSettings({ tts: { mimo: "не объект" } }).tts.mimo, {});
	assert.deepEqual(sanitizeSettings({ asr: [1, 2, 3] }).asr, {});
});
test("多个引擎的槽互不影响", () => {
	const out = sanitizeSettings({ tts: { edge: { voice: "zh-CN-YunxiNeural" }, mimo: { apiKey: "mk" } } });
	assert.deepEqual(out.tts.edge, { voice: "zh-CN-YunxiNeural" });
	assert.deepEqual(out.tts.mimo, { apiKey: "mk" });
});

console.log("\nsanitizeSettings: speechLang 白名单");
test("白名单内的四个语言原样保留", () => {
	for (const lang of ["ru-RU", "zh-CN", "en-US", "ja-JP"]) {
		assert.equal(sanitizeSettings({ speechLang: lang }).speechLang, lang);
	}
});
test("白名单外的值 → null（回落到 ru-RU）", () => {
	assert.equal(sanitizeSettings({ speechLang: "de-DE" }).speechLang, null);
	assert.equal(sanitizeSettings({ speechLang: "ru" }).speechLang, null);
});
test("值两边的空格被 trim 后再判定", () => {
	assert.equal(sanitizeSettings({ speechLang: "  zh-CN  " }).speechLang, "zh-CN");
	assert.equal(sanitizeSettings({ speechLang: " ru-RU " }).speechLang, "ru-RU");
});
test("非字符串（数字/null）不会误判成合法语言", () => {
	assert.equal(sanitizeSettings({ speechLang: 5 }).speechLang, null);
	assert.equal(sanitizeSettings({ speechLang: null }).speechLang, null);
});

console.log("\nsanitizeSettings: 布尔字段与字符串 \"false\"");
test("autoSend: true/false 原样", () => {
	assert.equal(sanitizeSettings({ autoSend: true }).autoSend, true);
	assert.equal(sanitizeSettings({ autoSend: false }).autoSend, false);
});
test("autoSend: 字符串 \"false\" → false", () => {
	assert.equal(sanitizeSettings({ autoSend: "false" }).autoSend, false);
});
test("autoSend: 字符串 \"true\" → true", () => {
	assert.equal(sanitizeSettings({ autoSend: "true" }).autoSend, true);
});
test("rewrite: 字符串 \"false\" → false", () => {
	assert.equal(sanitizeSettings({ rewrite: "false" }).rewrite, false);
	assert.equal(sanitizeSettings({ rewrite: "true" }).rewrite, true);
});
test("continuousMode: 字符串 \"false\" → false", () => {
	assert.equal(sanitizeSettings({ continuousMode: "false" }).continuousMode, false);
});
test("未提供的布尔键不出现（不覆盖已存设置）", () => {
	const out = sanitizeSettings({ silenceMs: 1000 });
	assert.equal("autoSend" in out, false);
	assert.equal("rewrite" in out, false);
	assert.equal("continuousMode" in out, false);
});

console.log("\n空输入 / null / undefined 的容错");
test("sanitizeSettings(null/undefined/数组/字符串) → 空补丁", () => {
	assert.deepEqual(sanitizeSettings(null), {});
	assert.deepEqual(sanitizeSettings(undefined), {});
	assert.deepEqual(sanitizeSettings([]), {});
	assert.deepEqual(sanitizeSettings("nope"), {});
});
test("mergeSettings(null, 补丁) 正常工作", () => {
	const merged = mergeSettings(null, sanitizeSettings({ silenceMs: 1200 }));
	assert.equal(merged.silenceMs, 1200);
	assert.deepEqual(merged.asr, {});
	assert.deepEqual(merged.tts, {});
});
test("resolveAsrConfig / resolveTtsConfig 对 null 输入不抛错", () => {
	assert.equal(resolveAsrConfig(null, null).engine, "siliconflow");
	assert.equal(resolveTtsConfig(null, null, "edge", "").engine, "edge");
	assert.equal(resolveTtsEngine(null, null), "edge");
});

console.log("\n迁移/合并的边角用例");
test("迁移：ttsEngine=local 时音色归 local，不污染 edge", () => {
	const m = migrateLegacySettings({ ttsEngine: "local", ttsVoice: "ru_RU-irina-medium" });
	assert.equal(m.tts.local.voice, "ru_RU-irina-medium");
	assert.equal(m.tts.edge, undefined, "本地 piper 音色不该被写进 Edge 槽（Edge 会拿到非法音色）");
});
test("迁移：ttsEngine=browser 且音色为空时不产生槽", () => {
	const m = migrateLegacySettings({ ttsEngine: "browser", ttsVoice: "" });
	assert.deepEqual(m.tts, {});
});
test("迁移：ttsEngine=edge 且音色不带 Neural 时仍归 edge（用户当前引擎的音色）", () => {
	const m = migrateLegacySettings({ ttsEngine: "edge", ttsVoice: "alloy" });
	assert.equal(m.tts.edge.voice, "alloy");
});
test("迁移：空白扁平键视为未设置（trim 后为空）", () => {
	const m = migrateLegacySettings({ ttsEngine: "custom", ttsBaseUrl: "   ", ttsApiKey: "  k  ", ttsVoice: "  " });
	assert.equal(m.tts.custom.baseUrl, "", "空白 URL 归一化为空串，不落脏值");
	assert.equal(m.tts.custom.apiKey, "k");
	assert.equal(m.tts.custom.voice, undefined, "空白音色不产生 voice 槽");
	assert.equal(migrateLegacySettings({ ttsEngine: "custom", ttsBaseUrl: "   " }).tts.custom, undefined,
		"所有扁平键都空白 → 完全不产生槽");
});
test("迁移：空输入 → 空槽", () => {
	const m = migrateLegacySettings(undefined);
	assert.deepEqual(m.asr, {});
	assert.deepEqual(m.tts, {});
});
test("合并：patch 里 asr 为 null 时不覆盖已存槽", () => {
	const saved = mergeSettings({}, sanitizeSettings({ asr: { groq: { apiKey: "gsk" } } }));
	const merged = mergeSettings(saved, sanitizeSettings({ asrEngine: "custom" }));
	assert.equal(merged.asr.groq.apiKey, "gsk");
});
test("合并：ttsEngine=edge 时旧扁平 URL/密钥不进 edge，音色进 edge", () => {
	const saved = mergeSettings({}, sanitizeSettings({
		ttsEngine: "edge", ttsVoice: " zh-CN-XiaoxiaoNeural ", ttsBaseUrl: "http://x/v1", ttsApiKey: "k", ttsModel: "tts-1"
	}));
	assert.deepEqual(saved.tts.edge, { voice: "zh-CN-XiaoxiaoNeural" });
	assert.equal(saved.tts.custom, undefined);
});
test("合并：ttsEngine=local 时旧扁平凭据/音色都归 local", () => {
	const saved = mergeSettings({}, sanitizeSettings({
		ttsEngine: "local", ttsBaseUrl: "http://127.0.0.1:8765/v1", ttsApiKey: "lk", ttsVoice: "ru_RU-irina-medium"
	}));
	assert.deepEqual(saved.tts.local, {
		baseUrl: "http://127.0.0.1:8765/v1",
		apiKey: "lk",
		voice: "ru_RU-irina-medium"
	});
	assert.equal(saved.tts.edge, undefined);
});
test("回显：未保存任何配置时每个引擎都拿到内置默认", () => {
	const slots = buildPublicSlots({}, {}, "");
	assert.equal(slots.tts.edge.voice, "ru-RU-SvetlanaNeural");
	assert.equal(slots.tts.mimo.baseUrl, "https://api.xiaomimimo.com/v1");
	assert.equal(slots.asr.siliconflow.model, "FunAudioLLM/SenseVoiceSmall");
	assert.equal(slots.asr.local.baseUrl, "http://127.0.0.1:8765/v1");
});
test("回显：edge 音色兜底只在 edge 槽生效，不漏给 custom", () => {
	const slots = buildPublicSlots({}, {}, "zh-CN-YunxiNeural");
	assert.equal(slots.tts.edge.voice, "zh-CN-YunxiNeural");
	assert.equal(slots.tts.custom.voice, "alloy");
});
test("解析：未知 TTS 引擎名回落到内置默认但保留传入的 engine 字段", () => {
	const cfg = resolveTtsConfig({}, {}, "unknown", "");
	assert.equal(cfg.engine, "unknown", "engine 字段原样回传，由调用方决定如何处理");
	assert.equal(cfg.model, "", "未知引擎没有专属默认 → 回落 edge 默认（空模型）");
	assert.equal(cfg.voice, "ru-RU-SvetlanaNeural");
	assert.equal(cfg.baseUrl, "");
});

console.log("\ncleanForTts: markdown");
test("代码块整体删除", () => {
	assert.equal(cleanForTts("```js\nconsole.log(1)\n```\nПривет"), "Привет");
});
test("未闭合的代码围栏也整体删除", () => {
	assert.equal(cleanForTts("текст ```js\nconsole.log(1)"), "текст");
});
test("行内代码去反引号、留内容", () => {
	assert.equal(cleanForTts("Инлайн `код` тут"), "Инлайн код тут");
});
test("markdown 链接只留文字", () => {
	assert.equal(cleanForTts("Ссылка [текст](http://a.b/c)"), "Ссылка текст");
});
test("表格分隔行删除，竖线换成空格", () => {
	assert.equal(cleanForTts("| a | b |\n| --- | --- |\n| 1 | 2 |"), "a b\n1 2");
});
test("无序列表符删除，保留条目文字", () => {
	assert.equal(cleanForTts("- пункт один\n+ пункт два"), "пункт один\nпункт два");
});
test("有序列表符删除（含数字后跟顿号、无空格）", () => {
	assert.equal(cleanForTts("1. первый\n2、второй\n3) третий"), "первый\nвторой\nтретий");
});
test("标题/强调/引用符号清掉后不留行首空格", () => {
	assert.equal(cleanForTts("# Заголовок"), "Заголовок");
	assert.equal(cleanForTts("> цитата"), "цитата");
	assert.equal(cleanForTts("**жирный** и _курсив_"), "жирный и курсив");
});

console.log("\ncleanForTts: emoji 与装饰符号");
test("emoji 表情被删除（\u{1F000}-\u{1FAFF} 区间）", () => {
	assert.equal(cleanForTts("Привет 😀 мир 🚀🎉"), "Привет мир");
});
test("装饰符号区被删除（\u2600-\u27BF 区间）", () => {
	assert.equal(cleanForTts("тест ☀ ★ ✈ ✿"), "тест");
});
test("杂项符号/箭头替换成空格而不是拼接成词", () => {
	assert.equal(cleanForTts("A → B · C ✓"), "A B C");
});
test("肤色修饰与变体选择符被删除，不留残码元", () => {
	assert.equal(cleanForTts("да 👍🏽\uFE0F нет"), "да нет");
});

console.log("\ncleanForTts: 标点与空白");
test("重复标点压缩（！！！→！）", () => {
	assert.equal(cleanForTts("Ура！！！"), "Ура！");
	assert.equal(cleanForTts("Точка..."), "Точка.");
	assert.equal(cleanForTts("Дааааа,,,"), "Дааааа,", "半角逗号重复同样压缩");
	assert.equal(cleanForTts("Пауза,,, да"), "Пауза, да");
});
test("连续空格被压成一个", () => {
	assert.equal(cleanForTts("a     b"), "a b");
});
test("空串/空白串/null/undefined → 空串", () => {
	assert.equal(cleanForTts(""), "");
	assert.equal(cleanForTts("   \t "), "");
	assert.equal(cleanForTts(null), "");
	assert.equal(cleanForTts(undefined), "");
});
test("数字与非字符串输入不会抛错", () => {
	assert.equal(cleanForTts(123), "123");
});
test("纯符号输入清洗后为空", () => {
	assert.equal(cleanForTts("```\n**`\n```"), "");
});

console.log("\ndetectAudioMime");
test("RIFF/WAVE → audio/wav", () => {
	assert.equal(detectAudioMime(wavHeader()), "audio/wav");
});
test("ID3 头 → audio/mpeg", () => {
	const buf = Buffer.concat([Buffer.from("ID3", "latin1"), Buffer.alloc(20)]);
	assert.equal(detectAudioMime(buf), "audio/mpeg");
});
test("MPEG 帧同步 0xFF 0xE0 → audio/mpeg", () => {
	assert.equal(detectAudioMime(Buffer.from([0xff, 0xe0, 0x00])), "audio/mpeg");
	assert.equal(detectAudioMime(Buffer.from([0xff, 0xfb, 0x90, 0x00])), "audio/mpeg");
});
test("webm/其它容器 → 空串", () => {
	assert.equal(detectAudioMime(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6, 7, 8, 9])), "");
	assert.equal(detectAudioMime(Buffer.from("OggS")), "");
});
test("太短的缓冲 → 空串，不抛错", () => {
	assert.equal(detectAudioMime(Buffer.alloc(0)), "");
	assert.equal(detectAudioMime(Buffer.from([0xff])), "");
	assert.equal(detectAudioMime(Buffer.from([0xff, 0xe0])), "audio/mpeg", "2 字节也够判帧同步");
});
test("只有 RIFF 而没有 WAVE 的容器不是 wav", () => {
	assert.equal(detectAudioMime(Buffer.from("RIFF____AVI ")), "");
});

console.log("\nASR 响应解析");
test("transcriptions: 取 text 字段", () => {
	assert.equal(parseTranscriptionText({ text: " привет " }), " привет ");
});
test("transcriptions: 没有 text → 空串", () => {
	assert.equal(parseTranscriptionText({}), "");
	assert.equal(parseTranscriptionText(null), "");
	assert.equal(parseTranscriptionText("строка"), "");
});
test("chat: content 是字符串", () => {
	assert.equal(parseChatContent({ choices: [{ message: { content: "привет" } }] }), "привет");
});
test("chat: content 是分段数组（拼接）", () => {
	assert.equal(parseChatContent({
		choices: [{ message: { content: [{ type: "text", text: "при" }, { type: "text", text: "вет" }] } }]
	}), "привет");
});
test("chat: 分段数组里混入裸字符串与非文本块", () => {
	assert.equal(parseChatContent({
		choices: [{ message: { content: ["a", { type: "audio", audio: {} }, { text: "b" }, null] } }]
	}), "ab");
});
test("chat: choices 缺失/为空 → 空串", () => {
	assert.equal(parseChatContent({}), "");
	assert.equal(parseChatContent({ choices: [] }), "");
	assert.equal(parseChatContent(null), "");
	assert.equal(parseChatContent({ choices: [{}] }), "");
});

console.log("\nASR 集成（本地假服务，不出网）");
/** 起一个本地 HTTP 假 ASR；handler 收到 (req, res, body) 由各用例决定回什么。 */
function startFakeAsr(handler) {
	const server = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => handler(req, res, Buffer.concat(chunks)));
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
		});
	});
}
const closeServer = (server) => new Promise((resolve) => server.close(resolve));

await testAsync("transcribe: multipart /audio/transcriptions 返回 text", async () => {
	let seen = null;
	const { server, baseUrl } = await startFakeAsr((req, res, body) => {
		seen = { url: req.url, auth: req.headers.authorization, body: body.toString("latin1") };
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ text: "  Привет, это тест  " }));
	});
	try {
		const text = await transcribe(Buffer.from([1, 2, 3]), {
			engine: "siliconflow", baseUrl: `${baseUrl}/v1`, model: "whisper", apiKey: "sk-test"
		});
		assert.equal(text, "Привет, это тест");
		assert.equal(seen.url, "/v1/audio/transcriptions");
		assert.equal(seen.auth, "Bearer sk-test");
		assert.match(seen.body, /name="model"[\s\S]*whisper/);
		assert.match(seen.body, /name="file"/);
	} finally {
		await closeServer(server);
	}
});

await testAsync("transcribe: baseUrl 带结尾斜杠不产生双斜杠", async () => {
	let seenUrl = null;
	const { server, baseUrl } = await startFakeAsr((req, res) => {
		seenUrl = req.url;
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ text: "ok" }));
	});
	try {
		await transcribe(Buffer.from([1]), { engine: "custom", baseUrl: `${baseUrl}/v1/`, model: "m", apiKey: "k" });
		assert.equal(seenUrl, "/v1/audio/transcriptions");
	} finally {
		await closeServer(server);
	}
});

await testAsync("transcribe: 缺 apiKey → status 400，不发请求", async () => {
	await assert.rejects(
		() => transcribe(Buffer.from([1]), { engine: "siliconflow", baseUrl: "http://127.0.0.1:1/v1", model: "m", apiKey: "" }),
		(err) => {
			assert.equal(err.status, 400);
			assert.match(err.message, /ASR/);
			return true;
		}
	);
});

await testAsync("transcribe: 上游 500 → status 502 且带 error.message", async () => {
	const { server, baseUrl } = await startFakeAsr((req, res) => {
		res.writeHead(500, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: { message: "upstream boom" } }));
	});
	try {
		await assert.rejects(
			() => transcribe(Buffer.from([1]), { engine: "siliconflow", baseUrl: `${baseUrl}/v1`, model: "m", apiKey: "k" }),
			(err) => {
				assert.equal(err.status, 502);
				assert.match(err.message, /upstream boom/);
				return true;
			}
		);
	} finally {
		await closeServer(server);
	}
});

await testAsync("transcribe: 非 JSON 错误页也带进报错", async () => {
	const { server, baseUrl } = await startFakeAsr((req, res) => {
		res.writeHead(502, { "Content-Type": "text/html" });
		res.end("<html>bad gateway</html>");
	});
	try {
		await assert.rejects(
			() => transcribe(Buffer.from([1]), { engine: "siliconflow", baseUrl: `${baseUrl}/v1`, model: "m", apiKey: "k" }),
			(err) => {
				assert.equal(err.status, 502);
				assert.match(err.message, /bad gateway/);
				return true;
			}
		);
	} finally {
		await closeServer(server);
	}
});

await testAsync("transcribe: 空响应体 → status 502", async () => {
	const { server, baseUrl } = await startFakeAsr((req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end("");
	});
	try {
		await assert.rejects(
			() => transcribe(Buffer.from([1]), { engine: "siliconflow", baseUrl: `${baseUrl}/v1`, model: "m", apiKey: "k" }),
			(err) => {
				assert.equal(err.status, 502);
				assert.match(err.message, /пустой ответ/);
				return true;
			}
		);
	} finally {
		await closeServer(server);
	}
});

await testAsync("transcribe: engine=mimo 自动走 chat 协议", async () => {
	let seen = null;
	const { server, baseUrl } = await startFakeAsr((req, res, body) => {
		seen = { url: req.url, body: JSON.parse(body.toString("utf8")) };
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ choices: [{ message: { content: " из mimo " } }] }));
	});
	try {
		const text = await transcribe(wavHeader(), {
			engine: "mimo", baseUrl: `${baseUrl}/v1/chat/completions`, model: "mimo-v2.5-asr", apiKey: "mk"
		});
		assert.equal(text, "из mimo");
		assert.equal(seen.url, "/v1/chat/completions");
		assert.equal(seen.body.messages[0].content[0].input_audio.format, "wav");
		assert.match(seen.body.messages[0].content[0].input_audio.data, /^data:audio\/wav;base64,/);
	} finally {
		await closeServer(server);
	}
});

await testAsync("transcribe: baseUrl 以 /chat/completions 结尾也走 chat 协议", async () => {
	let seenUrl = null;
	const { server, baseUrl } = await startFakeAsr((req, res) => {
		seenUrl = req.url;
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ choices: [{ message: { content: [{ text: "ку" }, { text: "сок" }] } }] }));
	});
	try {
		const text = await transcribe(wavHeader(), {
			engine: "custom", baseUrl: `${baseUrl}/v1/chat/completions/`, model: "m", apiKey: "k"
		});
		assert.equal(text, "кусок", "content 是分段数组时也要拼起来");
		assert.equal(seenUrl, "/v1/chat/completions", "结尾斜杠要被去掉");
	} finally {
		await closeServer(server);
	}
});

await testAsync("transcribe: mp3 音频的 chat 请求用 mp3 格式", async () => {
	let seen = null;
	const { server, baseUrl } = await startFakeAsr((req, res, body) => {
		seen = JSON.parse(body.toString("utf8"));
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ choices: [{ message: { content: "да" } }] }));
	});
	try {
		await transcribe(Buffer.from([0xff, 0xfb, 0x90, 0x00]), {
			engine: "mimo", baseUrl: `${baseUrl}/v1/chat/completions`, model: "m", apiKey: "k"
		});
		assert.equal(seen.messages[0].content[0].input_audio.format, "mp3");
	} finally {
		await closeServer(server);
	}
});

await testAsync("chat ASR: 非 wav/mp3 音频 → status 400", async () => {
	await assert.rejects(
		() => transcribeWithChatAsr(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]), {
			baseUrl: "http://127.0.0.1:1/v1/chat/completions", model: "m", apiKey: "k"
		}),
		(err) => {
			assert.equal(err.status, 400);
			assert.match(err.message, /wav\/mp3/);
			return true;
		}
	);
});

await testAsync("chat ASR: 上游报错 → status 502", async () => {
	const { server, baseUrl } = await startFakeAsr((req, res) => {
		res.writeHead(401, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: { message: "bad key" } }));
	});
	try {
		await assert.rejects(
			() => transcribeWithChatAsr(wavHeader(), { baseUrl: `${baseUrl}/v1/chat/completions`, model: "m", apiKey: "k" }),
			(err) => {
				assert.equal(err.status, 502);
				assert.match(err.message, /bad key/);
				return true;
			}
		);
	} finally {
		await closeServer(server);
	}
});

await testAsync("chat ASR: 空 JSON 对象 → status 502（不抛 Object.keys 错）", async () => {
	const { server, baseUrl } = await startFakeAsr((req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end("{}");
	});
	try {
		await assert.rejects(
			() => transcribeWithChatAsr(wavHeader(), { baseUrl: `${baseUrl}/v1/chat/completions`, model: "m", apiKey: "k" }),
			(err) => {
				assert.equal(err.status, 502);
				return true;
			}
		);
	} finally {
		await closeServer(server);
	}
});

await testAsync("chat ASR: JSON null 响应 → status 502（不抛 Object.keys 错）", async () => {
	const { server, baseUrl } = await startFakeAsr((req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end("null");
	});
	try {
		await assert.rejects(
			() => transcribeWithChatAsr(wavHeader(), { baseUrl: `${baseUrl}/v1/chat/completions`, model: "m", apiKey: "k" }),
			(err) => {
				assert.equal(err.status, 502, "旧实现会在 Object.keys(null) 上崩成 500");
				return true;
			}
		);
	} finally {
		await closeServer(server);
	}
});

console.log("\nedge-tts: Sec-MS-GEC 令牌（纯计算，无网络）");
test("同一秒 → 同一令牌", () => {
	assert.equal(generateSecMsGec(1_700_000_000.4), generateSecMsGec(1_700_000_000.9));
});
test("令牌是 64 位大写十六进制（SHA-256）", () => {
	assert.match(generateSecMsGec(1_700_000_000), /^[0-9A-F]{64}$/);
});
test("同一 300 秒窗口内稳定（窗口对齐）", () => {
	// 窗口按 (unix + WIN_EPOCH) 对齐到 300s，取一个窗口起点做基准
	const base = 1_700_000_000 - ((1_700_000_000 + 11_644_473_600) % 300);
	const token = generateSecMsGec(base);
	for (const offset of [0, 1, 60, 150, 299]) {
		assert.equal(generateSecMsGec(base + offset), token, `偏移 ${offset}s 应落在同一窗口`);
	}
});
test("跨过 300 秒窗口边界 → 令牌变化", () => {
	const base = 1_700_000_000 - ((1_700_000_000 + 11_644_473_600) % 300);
	assert.notEqual(generateSecMsGec(base + 300), generateSecMsGec(base));
});
test("不同时间不同时刻令牌不同（时刻参与运算）", () => {
	assert.notEqual(generateSecMsGec(1_700_000_000), generateSecMsGec(1_800_000_000));
});

console.log("\nedge-tts: SSML");
const ssml = (opts) => buildSsml({
	voice: "ru-RU-SvetlanaNeural", pitch: "+0Hz", rate: "+10%", text: "тест", ...opts
});

test("xml:lang 从音色前缀取出（zh-CN-XiaoxiaoNeural）", () => {
	assert.match(ssml({ voice: "zh-CN-XiaoxiaoNeural" }), /xml:lang='zh-CN'/);
});
test("xml:lang 从音色前缀取出（ru-RU-SvetlanaNeural）", () => {
	assert.match(ssml({}), /xml:lang='ru-RU'/);
});
test("音色没有语言前缀时默认 ru-RU", () => {
	assert.match(ssml({ voice: "alloy" }), /xml:lang='ru-RU'/);
});
test("voice name 用完整音色名", () => {
	assert.match(ssml({ voice: "en-US-JennyNeural" }), /<voice name='en-US-JennyNeural'>/);
});
test("prosody 带 pitch 与 rate", () => {
	assert.match(ssml({ pitch: "+5Hz", rate: "-20%" }), /<prosody pitch='\+5Hz' rate='-20%' volume='\+0%'>/);
});
test("& < > 被转义", () => {
	const xml = ssml({ text: "A & B <tag> \"q\"" });
	assert.match(xml, /A &amp; B &lt;tag&gt; "q"/);
	assert.equal(xml.includes("A & B"), false);
});
test("包装成完整 speak 文档（version + xmlns）", () => {
	const xml = ssml({});
	assert.ok(xml.startsWith("<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis'"));
	assert.ok(xml.endsWith("</prosody></voice></speak>"));
});

console.log(`\n${passed} пройдено${process.exitCode ? " (есть падения)" : ""}`);