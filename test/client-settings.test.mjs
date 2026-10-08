/**
 * 浏览器端设置表单自测：用极简 React 桩渲染 VoiceChatSettingsSection，
 * 验证"切 TTS 引擎时表单只显示该引擎自己的槽、保存只提交该引擎的槽"。
 * 运行：node test/client-settings.test.mjs
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_SRC = path.join(HERE, "..", "lib", "client.js");

// ---------- 极简 React 桩（useState/useEffect/useRef/createElement 足够渲染本表单） ----------
function createReactStub() {
	const states = [];
	const refs = [];
	const effects = [];
	let cursor = 0;
	const Fragment = Symbol("Fragment");
	const createElement = (type, props, ...children) => ({
		type,
		props: props || {},
		children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
	});
	const React = {
		Fragment,
		createElement,
		useState(init) {
			const i = cursor++;
			if (!(i in states)) states[i] = typeof init === "function" ? init() : init;
			const set = (v) => { states[i] = typeof v === "function" ? v(states[i]) : v; };
			return [states[i], set];
		},
		useRef(init) {
			const i = cursor++;
			if (!(i in refs)) refs[i] = { current: init };
			return refs[i];
		},
		useEffect(fn, deps) {
			const i = cursor++;
			const prev = effects[i];
			const changed = !prev || !deps || !prev.deps || deps.length !== prev.deps.length
				|| deps.some((d, k) => d !== prev.deps[k]);
			effects[i] = { fn, deps, pending: changed };
		},
		useCallback(fn) { return fn; },
		useMemo(fn) { return fn(); }
	};
	return {
		React,
		beginRender() { cursor = 0; },
		runEffects() {
			for (const entry of effects) {
				if (!entry || !entry.pending) continue;
				entry.pending = false;
				entry.fn();
			}
		}
	};
}

/** 加载 lib/client.js，拿到它注册到 settings.section 的组件。 */
async function loadSettingsSection(reactStub, fetchImpl) {
	const src = await readFile(CLIENT_SRC, "utf8");
	let captured = null;
	const windowStub = {
		fetch: fetchImpl,
		setTimeout: () => 0,
		clearTimeout: () => {},
		addEventListener: () => {},
		removeEventListener: () => {},
		__ModuleLoader__: { load(spec) { captured = spec; } }
	};
	// 用 Function 构造出浏览器风格环境，执行 IIFE 风格的 client.js
	const fn = new Function(
		"window", "console", "navigator", "setTimeout", "clearTimeout", "URL",
		src
	);
	fn(windowStub, console, { mediaDevices: {} }, () => 0, () => {}, URL);
	assert.ok(captured && typeof captured.factory === "function", "client.js 应通过 __ModuleLoader__.load 注册 factory");
	const requireStub = (name) => {
		if (name === "react") return reactStub.React;
		throw new Error("unexpected require: " + name);
	};
	const exportsObj = captured.factory(requireStub);
	assert.equal(typeof exportsObj.apply, "function");

	const registered = {};
	const fakeSlots = {
		inject(name, fn) { return fn(); },
		register(meta, component) {
			registered[meta.name] = component;
			return () => {};
		}
	};
	exportsObj.apply({
		get: (name) => (name === "slots" ? fakeSlots : undefined),
		inject: (deps, fn) => fn({ slots: fakeSlots, modelDirectories: null })
	});
	assert.equal(typeof registered["settings.section"], "function", "应注册 settings.section 组件");
	return registered["settings.section"];
}

// ---------- 元素树工具 ----------
function walk(node, visit) {
	if (!node || typeof node !== "object") return;
	visit(node);
	for (const child of node.children || []) walk(child, visit);
}
function textOf(node) {
	if (typeof node === "string") return node;
	if (!node || typeof node !== "object") return "";
	return (node.children || []).map(textOf).join("");
}
/** 找到 field(label, control) 渲染出的控件，返回它的 props。 */
function controlByLabel(tree, labelText) {
	let found = null;
	walk(tree, (node) => {
		if (found || node.type !== "div") return;
		const kids = node.children || [];
		const label = kids[0];
		if (!label || label.type !== "label") return;
		if (textOf(label) !== labelText) return;
		found = kids[1];
	});
	assert.ok(found, `Поле не найдено: «${labelText}»`);
	return found;
}
/** 找到某个 select/input 的 onChange 回调。 */
function onChangeOf(tree, labelText) {
	const control = controlByLabel(tree, labelText);
	assert.equal(typeof control.props.onChange, "function", `Поле «${labelText}» должно иметь onChange`);
	return control.props.onChange;
}

// 新版宿主 /settings 回显：每引擎一份槽
const HOST_SETTINGS = {
	version: "0.4.0",
	asrEngine: "custom",
	asrBaseUrl: "http://127.0.0.1:52625/v1",
	asrModel: "whisper-v3",
	asrApiKey: "flm",
	autoSend: false,
	silenceMs: 2000,
	rewrite: true,
	ttsEngine: "mimo",
	ttsVoice: "冰糖",
	ttsBaseUrl: "https://api.xiaomimimo.com/v1",
	ttsModel: "mimo-v2.5-tts",
	ttsApiKey: "mimo-key",
	asrConfig: {
		siliconflow: { baseUrl: "https://api.siliconflow.cn/v1", model: "FunAudioLLM/SenseVoiceSmall", apiKey: "" },
		groq: { baseUrl: "https://api.groq.com/openai/v1", model: "whisper-large-v3-turbo", apiKey: "" },
		mimo: { baseUrl: "https://api.xiaomimimo.com/v1/chat/completions", model: "mimo-v2.5-asr", apiKey: "" },
		custom: { baseUrl: "http://127.0.0.1:52625/v1", model: "whisper-v3", apiKey: "flm" }
	},
	ttsConfig: {
		edge: { baseUrl: "", model: "", apiKey: "", voice: "zh-CN-YunxiNeural" },
		mimo: { baseUrl: "https://api.xiaomimimo.com/v1", model: "mimo-v2.5-tts", apiKey: "mimo-key", voice: "冰糖" },
		custom: { baseUrl: "http://127.0.0.1:52992/v1", model: "kokoro-82m-zh", apiKey: "custom-key", voice: "Mia" }
	}
};

const posts = [];
const fetchImpl = (url, options = {}) => {
	if (options.method === "POST") {
		posts.push({ url, body: JSON.parse(options.body) });
		return Promise.resolve({
			ok: true,
			status: 200,
			json: () => Promise.resolve({ ok: true, settings: HOST_SETTINGS })
		});
	}
	return Promise.resolve({
		ok: true,
		status: 200,
		json: () => Promise.resolve(HOST_SETTINGS)
	});
};

const stub = createReactStub();
const Section = await loadSettingsSection(stub, fetchImpl);

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

/** 渲染一次：先调用注册的包装组件，再展开它里面的函数组件（本测试用不上真正的调度）。 */
function renderOnce(SectionFn, stubX) {
	stubX.beginRender();
	let el = SectionFn({});
	if (el && typeof el.type === "function") {
		el = el.type(el.props);
	}
	stubX.runEffects();
	return el;
}

let tree;
async function render() {
	tree = renderOnce(Section, stub);
	await flush();
	// 设置到达后（useSettings 广播）再渲染两次，让回填 effect 跑起来
	tree = renderOnce(Section, stub);
	tree = renderOnce(Section, stub);
	if (process.env.DEBUG_TREE) console.log(JSON.stringify(tree, (k, v) => (typeof v === "function" ? "[fn]" : v), 1).slice(0, 3000));
}

let passed = 0;
async function test(name, fn) {
	try {
		await fn();
		passed += 1;
		console.log(`  ok  ${name}`);
	} catch (err) {
		console.error(`FAIL  ${name}`);
		console.error(err);
		process.exitCode = 1;
	}
}

await render();

	console.log("Форма настроек отображается по движкам (без смешивания)");
await test("Текущий движок MiMo: отображаются собственные адрес/ключ/голос", () => {
	assert.equal(controlByLabel(tree, "TTS Base URL").props.value, "https://api.xiaomimimo.com/v1");
	assert.equal(controlByLabel(tree, "API-ключ TTS").props.value, "mimo-key");
	assert.equal(controlByLabel(tree, "Голос (MiMo TTS)").props.value, "冰糖");
});

await test("Переключение на пользовательский TTS: отображается его конфигурация, значения MiMo не видны", () => {
	onChangeOf(tree, "Движок TTS")({ target: { value: "custom" } });
	tree = renderOnce(Section, stub);
	assert.equal(controlByLabel(tree, "TTS Base URL").props.value, "http://127.0.0.1:52992/v1");
	assert.equal(controlByLabel(tree, "Модель TTS").props.value, "kokoro-82m-zh");
	assert.equal(controlByLabel(tree, "API-ключ TTS").props.value, "custom-key");
	assert.equal(controlByLabel(tree, "Голос (Пользовательский TTS)").props.value, "Mia");
});

await test("Переключение на Edge: отображается только его голос (Mia/冰糖 не появляются)", () => {
	onChangeOf(tree, "Движок TTS")({ target: { value: "edge" } });
	tree = renderOnce(Section, stub);
	assert.equal(controlByLabel(tree, "Голос (Edge TTS)").props.value, "zh-CN-YunxiNeural");
});

await test("Возврат к MiMo: конфигурация MiMo не изменилась (не перезаписана custom)", () => {
	onChangeOf(tree, "Движок TTS")({ target: { value: "mimo" } });
	tree = renderOnce(Section, stub);
	assert.equal(controlByLabel(tree, "TTS Base URL").props.value, "https://api.xiaomimimo.com/v1");
	assert.equal(controlByLabel(tree, "API-ключ TTS").props.value, "mimo-key");
	assert.equal(controlByLabel(tree, "Голос (MiMo TTS)").props.value, "冰糖");
});

await test("Смена движка ASR: слоты custom и mimo не влияют друг на друга", () => {
	assert.equal(controlByLabel(tree, "ASR Base URL").props.value, "http://127.0.0.1:52625/v1");
	assert.equal(controlByLabel(tree, "API-ключ ASR").props.value, "flm");
	onChangeOf(tree, "Движок ASR")({ target: { value: "mimo" } });
	tree = renderOnce(Section, stub);
	assert.equal(controlByLabel(tree, "ASR Base URL").props.value, "https://api.xiaomimimo.com/v1/chat/completions");
	assert.equal(controlByLabel(tree, "API-ключ ASR").props.value, "");
	onChangeOf(tree, "Движок ASR")({ target: { value: "custom" } });
	tree = renderOnce(Section, stub);
	assert.equal(controlByLabel(tree, "API-ключ ASR").props.value, "flm");
});

console.log("\nСохранение отправляет только слот текущего движка");
await test("Сохранение MiMo: в tts только mimo, в ASR только пользовательский", async () => {
	posts.length = 0;
	const saveBtn = (() => {
		let found = null;
		walk(tree, (node) => {
			if (!found && node.type === "button" && textOf(node).includes("Сохранить")) found = node;
		});
		return found;
	})();
	assert.ok(saveBtn, "Должна быть кнопка сохранения");
	saveBtn.props.onClick();
	await flush();
	assert.equal(posts.length, 1, "Должен быть отправлен один POST");
	const body = posts[0].body;
	assert.deepEqual(Object.keys(body.tts), ["mimo"], "Отправляется только слот TTS текущего движка");
	assert.deepEqual(body.tts.mimo, {
		baseUrl: "https://api.xiaomimimo.com/v1",
		model: "mimo-v2.5-tts",
		apiKey: "mimo-key",
		voice: "冰糖"
	});
	assert.deepEqual(Object.keys(body.asr), ["custom"]);
	assert.equal(body.ttsEngine, "mimo");
	assert.equal(body.ttsConfig, undefined, "Не должна возвращаться вся конфигурация (включая другие движки)");
	// Плоские ключи для совместимости со старым хостом = значения текущего движка
	assert.equal(body.ttsBaseUrl, "https://api.xiaomimimo.com/v1");
	assert.equal(body.ttsApiKey, "mimo-key");
	assert.equal(body.ttsVoice, "冰糖");
	assert.equal(body.asrBaseUrl, "http://127.0.0.1:52625/v1");
});

await test("Сохранение после переключения на Edge: отправляется только голос, без адресов и ключей MiMo/пользовательского", async () => {
	onChangeOf(tree, "Движок TTS")({ target: { value: "edge" } });
	tree = renderOnce(Section, stub);
	posts.length = 0;
	let saveBtn = null;
	walk(tree, (node) => {
		if (!saveBtn && node.type === "button" && textOf(node).includes("Сохранить")) saveBtn = node;
	});
	saveBtn.props.onClick();
	await flush();
	const body = posts[0].body;
	assert.deepEqual(body.tts, { edge: { voice: "zh-CN-YunxiNeural" } });
	assert.equal(body.ttsBaseUrl, "", "Edge не должен отправлять адреса других движков");
	assert.equal(body.ttsApiKey, "");
	assert.equal(body.ttsModel, "");
});

console.log("\ncontinuousMode");
await test("Чекбокс «Постоянный диалог» существует", () => {
	const checkbox = (() => {
		let found = null;
		walk(tree, (node) => {
			if (!found && node.type === "label") {
				const kids = node.children || [];
				const text = textOf(node);
				if (text.includes("Постоянный диалог")) found = node;
			}
		});
		return found;
	})();
	assert.ok(checkbox, "Должен быть чекбокс «Постоянный диалог»");
});

console.log("\nСтарый хост (без asrConfig/ttsConfig): запасной вариант");
await test("Старый хост даёт только плоские ключи: используются как слот текущего движка", async () => {
	const legacy = {
		asrEngine: "custom", asrBaseUrl: "http://127.0.0.1:52625/v1", asrModel: "whisper-v3", asrApiKey: "flm",
		ttsEngine: "edge", ttsVoice: "zh-CN-XiaoxiaoNeural",
		ttsBaseUrl: "http://127.0.0.1:52992/v1", ttsModel: "kokoro-82m-zh", ttsApiKey: "custom-key"
	};
	const stub2 = createReactStub();
	const Section2 = await loadSettingsSection(stub2, () => Promise.resolve({
		ok: true, status: 200, json: () => Promise.resolve(legacy)
	}));
	let t2 = renderOnce(Section2, stub2);
	for (let i = 0; i < 5; i++) await Promise.resolve();
	t2 = renderOnce(Section2, stub2);
	t2 = renderOnce(Section2, stub2);
	// edge — текущий движок → голос из плоского ключа edge; плоские URL/ключ не отображаются в форме edge
	assert.equal(controlByLabel(t2, "Голос (Edge TTS)").props.value, "zh-CN-XiaoxiaoNeural");
	onChangeOf(t2, "Движок TTS")({ target: { value: "custom" } });
	t2 = renderOnce(Section2, stub2);
	assert.equal(controlByLabel(t2, "TTS Base URL").props.value, "", "Плоский адрес старого хоста относится только к текущему движку (edge), не может быть принят за custom");
	assert.equal(controlByLabel(t2, "ASR Base URL").props.value, "http://127.0.0.1:52625/v1", "Текущий движок ASR — custom, плоские ключи относятся к нему");
});

console.log(`\n${passed} пройдено${process.exitCode ? " (есть падения)" : ""}`);
