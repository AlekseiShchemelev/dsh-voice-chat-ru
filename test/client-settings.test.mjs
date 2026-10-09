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
		/** Текущая позиция курсора хуков — чтобы продолжать нумерацию после формы. */
		hookCursor() { return cursor; },
		resume(at) { cursor = at; },
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
		// Опрос статуса локального движка: в тесте интервал — пустая функция
		setInterval: () => 0,
		clearInterval: () => {},
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
/** Input внутри контрола (у порта контрол — обёртка с input и кнопкой). */
function inputOf(control) {
	let input = null;
	walk(control, (node) => { if (!input && node.type === "input") input = node; });
	assert.ok(input, "в контроле должен быть input");
	return input;
}
/** Поля с таким названием быть не должно (движок, которому оно не нужно). */
function assertNoField(tree, labelText) {
	const found = (() => {
		let hit = null;
		walk(tree, (node) => {
			if (hit || node.type !== "div") return;
			const kids = node.children || [];
			const label = kids[0];
			if (label && label.type === "label" && textOf(label) === labelText) hit = true;
		});
		return hit;
	})();
	assert.equal(found, null, `поле «${labelText}» должно быть скрыто`);
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

console.log("\nЛокальный движок: блок статуса и кнопки");
await test("При движке local в форме есть блок управления локальным движком", () => {
	onChangeOf(tree, "Движок ASR")({ target: { value: "local" } });
	tree = renderOnce(Section, stub);
	let box = null;
	walk(tree, (node) => { if (!box && typeof node.type === "function") box = node; });
	assert.ok(box, "Должен появиться блок локального движка");
	assert.match(box.type.name, /LocalEngineBox/);
	// Адрес и ключ для local не настраиваются вовсе
	assertNoField(tree, "ASR Base URL");
	assertNoField(tree, "API-ключ ASR");
	assert.ok(controlByLabel(tree, "Модель распознавания (faster-whisper)"), "модель выбирается списком");
	assert.ok(controlByLabel(tree, "Порт локального сервера"), "порт выбирается один на оба движка");
});

await test("При движке browser поля адреса/модели/ключа скрыты", () => {
	onChangeOf(tree, "Движок ASR")({ target: { value: "browser" } });
	tree = renderOnce(Section, stub);
	assertNoField(tree, "ASR Base URL");
	assertNoField(tree, "Модель ASR");
	assertNoField(tree, "API-ключ ASR");
	assertNoField(tree, "Модель распознавания (faster-whisper)");
	assert.match(textOf(tree), /Web Speech API/, "должна быть поясняющая записка");
	// У сетевых движков поля на месте
	onChangeOf(tree, "Движок ASR")({ target: { value: "custom" } });
	tree = renderOnce(Section, stub);
	assert.ok(controlByLabel(tree, "ASR Base URL"));
	assert.ok(controlByLabel(tree, "API-ключ ASR"));
});

await test("Движок local: модель и порт — списки с разумными значениями по умолчанию", () => {
	onChangeOf(tree, "Движок ASR")({ target: { value: "local" } });
	tree = renderOnce(Section, stub);
	const model = controlByLabel(tree, "Модель распознавания (faster-whisper)");
	assert.equal(model.props.value, "small", "по умолчанию small");
	const options = model.children.map((o) => o.props.value);
	assert.deepEqual(options, ["tiny", "base", "small", "medium", "large-v3"],
		"список должен совпадать с SUPPORTED_WHISPER_MODELS на сервере");
	model.props.onChange({ target: { value: "base" } });
	tree = renderOnce(Section, stub);
	assert.equal(controlByLabel(tree, "Модель распознавания (faster-whisper)").props.value, "base");
	const port = inputOf(controlByLabel(tree, "Порт локального сервера"));
	assert.equal(port.props.value, "8765", "порт по умолчанию 8765");
});

await test("Движок local (TTS): голос Piper — список, лишних полей нет", () => {
	onChangeOf(tree, "Движок TTS")({ target: { value: "local" } });
	tree = renderOnce(Section, stub);
	const voice = controlByLabel(tree, "Голос (локальный Piper)");
	assert.equal(voice.props.value, "ru_RU-irina-medium");
	assert.deepEqual(voice.children.map((o) => o.props.value), [
		"ru_RU-irina-medium", "ru_RU-ruslan-medium", "ru_RU-dmitri-medium", "ru_RU-denis-medium"
	]);
	voice.props.onChange({ target: { value: "ru_RU-denis-medium" } });
	tree = renderOnce(Section, stub);
	assert.equal(controlByLabel(tree, "Голос (локальный Piper)").props.value, "ru_RU-denis-medium");
});

await test("Движок browser (TTS): настраивать нечего", () => {
	onChangeOf(tree, "Движок TTS")({ target: { value: "browser" } });
	tree = renderOnce(Section, stub);
	assertNoField(tree, "TTS Base URL");
	assertNoField(tree, "Голос (локальный Piper)");
	assert.match(textOf(tree), /speechSynthesis/, "пояснение, что всё делает браузер");
});

await test("local: адрес выводится из порта и одинаков для ASR и TTS", async () => {
	onChangeOf(tree, "Движок ASR")({ target: { value: "local" } });
	onChangeOf(tree, "Движок TTS")({ target: { value: "local" } });
	tree = renderOnce(Section, stub);
	const port = inputOf(controlByLabel(tree, "Порт локального сервера"));
	port.props.onChange({ target: { value: "9000" } });
	tree = renderOnce(Section, stub);
	assert.equal(inputOf(controlByLabel(tree, "Порт локального сервера")).props.value, "9000");
	posts.length = 0;
	let saveBtn = null;
	walk(tree, (node) => { if (!saveBtn && node.type === "button" && textOf(node).includes("Сохранить")) saveBtn = node; });
	saveBtn.props.onClick();
	await flush();
	const body = posts[0].body;
	assert.equal(body.asr.local.baseUrl, "http://127.0.0.1:9000/v1");
	assert.equal(body.tts.local.baseUrl, "http://127.0.0.1:9000/v1",
		"сервер один: у ASR и TTS должен быть одинаковый адрес");
	assert.equal(body.asr.local.apiKey, "", "ключ не отправляется");
	assert.equal(body.tts.local.apiKey, "");
});

await test("local: дефолтный порт не пишется в настройки (работает встроенный адрес)", async () => {
	onChangeOf(tree, "Движок ASR")({ target: { value: "local" } });
	tree = renderOnce(Section, stub);
	// Возвращаем порт по умолчанию (предыдущий тест выставил 9000)
	const portInput = inputOf(controlByLabel(tree, "Порт локального сервера"));
	const portControl = controlByLabel(tree, "Порт локального сервера");
	const resetBtn = portControl.children.find((c) => c && c.type === "button" && /8765/.test(textOf(c)));
	assert.ok(resetBtn, "рядом с портом должна быть кнопка возврата к 8765");
	resetBtn.props.onClick();
	tree = renderOnce(Section, stub);
	assert.equal(portInput && inputOf(controlByLabel(tree, "Порт локального сервера")).props.value, "8765");
	posts.length = 0;
	let saveBtn = null;
	walk(tree, (node) => { if (!saveBtn && node.type === "button" && textOf(node).includes("Сохранить")) saveBtn = node; });
	saveBtn.props.onClick();
	await flush();
	assert.equal(posts[0].body.asr.local.baseUrl, "",
		"для дефолтного порта слот остаётся пустым → берётся значение движка по умолчанию");
});

await test("Порт, сохранённый раньше в адресе слота, подхватывается в форме", async () => {
	const stubP = createReactStub();
	const SectionP = await loadSettingsSection(stubP, () => Promise.resolve({
		ok: true, status: 200,
		json: () => Promise.resolve({
			...HOST_SETTINGS, asrEngine: "local",
			asrConfig: { ...HOST_SETTINGS.asrConfig, local: { baseUrl: "http://127.0.0.1:9321/v1", model: "base", apiKey: "" } }
		})
	}));
	let t = renderOnce(SectionP, stubP);
	await flush();
	t = renderOnce(SectionP, stubP);
	t = renderOnce(SectionP, stubP);
	assert.equal(inputOf(controlByLabel(t, "Порт локального сервера")).props.value, "9321");
	assert.equal(controlByLabel(t, "Модель распознавания (faster-whisper)").props.value, "base");
});

/** Рендерит блок локального движка с заданным статусом хоста. */
async function renderLocalBox(statusBody, posts) {
	const stubX = createReactStub();
	const SectionX = await loadSettingsSection(stubX, (url, options = {}) => {
		if (String(url).includes("/local/")) {
			// GET /local/status отдаёт сам объект статуса, POST — { ok, status }
			if (options.method === "POST") {
				posts.push(String(url));
				return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, status: statusBody }) });
			}
			return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(statusBody) });
		}
		return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(HOST_SETTINGS) });
	});
	let t = renderOnce(SectionX, stubX);
	await flush();
	t = renderOnce(SectionX, stubX);
	onChangeOf(t, "Движок ASR")({ target: { value: "local" } });
	t = renderOnce(SectionX, stubX);
	let node = null;
	walk(t, (n) => { if (!node && typeof n.type === "function") node = n; });
	assert.ok(node, "Блок локального движка должен рендериться");
	// Раскрываем сам компонент в том же стенде и БЕЗ сброса курсора: индексы
	// хуков продолжаются после хуков формы (иначе useState блока перезапишет
	// состояние формы, а его собственные слоты окажутся заняты).
	const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
	const mark = stubX.hookCursor();
	let box = node.type(node.props);
	stubX.runEffects();
	await settle();
	stubX.resume(mark);
	box = node.type(node.props);
	stubX.runEffects();
	await settle();
	// Перерисовка того же экземпляра: нужна для проверок с локальным состоянием
	// блока (например, подтверждение удаления) — состояние живёт в его useState
	const rerender = async () => {
		stubX.resume(mark);
		const next = node.type(node.props);
		stubX.runEffects();
		await settle();
		return next;
	};
	return { box, rerender };
}

const LOCAL_READY = {
	pythonReady: true, pythonPath: "python3", venvReady: true, modelsReady: true,
	serverRunning: false, installing: false, installStage: null, installError: null,
	port: 8765, pid: null, error: null, dataDir: "/home/u/.local/share/dsh-voice-chat"
};

const buttonByText = (tree, re) => {
	let found = null;
	walk(tree, (node) => { if (!found && node.type === "button" && re.test(textOf(node))) found = node; });
	return found;
};

await test("Блок показывает состояние окружения и кнопки управления", async () => {
	const { box } = await renderLocalBox(LOCAL_READY, []);
	const text = textOf(box);
	assert.match(text, /Python/, "Должна быть строка про Python");
	assert.match(text, /Модели/, "Должна быть строка про модели");
	assert.match(text, /не запущен/, "Незапущенный сервер отмечен в статусе");
	assert.match(text, /\/dsh-voice-chat/, "Показывается каталог данных");
	assert.ok(buttonByText(box, /Запустить сервер/), "Есть кнопка запуска сервера");
	assert.ok(buttonByText(box, /Остановить сервер/), "Есть кнопка остановки сервера");
	// Установленный, но не запущенный: установка не нужна, запустить — можно
	assert.match(textOf(buttonByText(box, /Установлено|Установить локальный/)), /Установлено/);
	assert.equal(buttonByText(box, /Установлено/).props.disabled, true);
	assert.equal(buttonByText(box, /Запустить сервер/).props.disabled, false);
	assert.equal(buttonByText(box, /Остановить сервер/).props.disabled, true, "Сервер не запущен — останавливать нечего");
});

await test("Кнопка «Запустить сервер» дёргает /local/start", async () => {
	const posts = [];
	const { box } = await renderLocalBox(LOCAL_READY, posts);
	await buttonByText(box, /Запустить сервер/).props.onClick();
	await flush();
	assert.deepEqual(posts, ["/dsh-voice-chat/local/start"]);
});

await test("Не установленный движок: кнопка установки активна и дёргает /local/install", async () => {
	const posts = [];
	const { box } = await renderLocalBox({
		...LOCAL_READY, venvReady: false, modelsReady: false,
		error: "Python не найден: установите python3 или задайте DSH_VOICE_PYTHON"
	}, posts);
	const btn = buttonByText(box, /Установить локальный движок/);
	assert.ok(btn, "Кнопка установки должна быть");
	assert.equal(btn.props.disabled, false);
	assert.match(textOf(box), /Python не найден/, "Причина отсутствия Python показывается");
	await btn.props.onClick();
	await flush();
	assert.deepEqual(posts, ["/dsh-voice-chat/local/install"]);
});

await test("Идущая установка показывает фазу и блокирует кнопки", async () => {
	const { box } = await renderLocalBox({
		...LOCAL_READY, installing: true, installStage: "models", venvReady: false, modelsReady: false
	}, []);
	const text = textOf(box);
	assert.match(text, /Установка/, "Показывается, что установка идёт");
	assert.match(text, /faster-whisper/, "Показывается текущая фаза установки");
	const installBtn = buttonByText(box, /Установка…/);
	assert.ok(installBtn, "Кнопка должна показывать, что установка идёт");
	assert.equal(installBtn.props.disabled, true);
});

await test("Ошибка установки показывается пользователю", async () => {
	const { box } = await renderLocalBox({
		...LOCAL_READY, venvReady: false, modelsReady: false,
		installError: "Модели не загружены: нет Piper-голоса"
	}, []);
	assert.match(textOf(box), /Ошибка установки: Модели не загружены/);
});

await test("Показывается различие «venv есть» и «пакеты импортируются»", async () => {
	const { box } = await renderLocalBox({
		...LOCAL_READY, depsReady: false, depsError: "No module named 'faster_whisper'"
	}, []);
	const text = textOf(box);
	assert.match(text, /venv есть, но faster-whisper \/ piper-tts не импортируются/);
	assert.match(text, /No module named 'faster_whisper'/, "причина импорта должна быть видна");
	// venv нет — строка про импорты не показывается
	const { box: noVenv } = await renderLocalBox({ ...LOCAL_READY, venvReady: false, depsReady: null }, []);
	assert.match(textOf(noVenv), /venv не создан/);
	// пакеты на месте — отдельная строка
	const { box: ok } = await renderLocalBox({ ...LOCAL_READY, depsReady: true }, []);
	assert.match(textOf(ok), /импортируются/);
});

await test("Причина сбоя и хвост лога установки показываются пользователю", async () => {
	const { box } = await renderLocalBox({
		...LOCAL_READY,
		venvReady: false, modelsReady: false, depsReady: false,
		installError: "Модели не загружены: нет Piper-голоса ... — urllib.error.URLError: <urlopen error timed out>",
		logFile: "C:\\Users\\sheme\\.local\\share\\dsh-voice-chat\\logs\\install.log",
		logTail: "Downloading https://huggingface.co/rhasspy/piper-voices/...\nurlopen error timed out"
	}, []);
	const text = textOf(box);
	assert.match(text, /urlopen error timed out/, "причина должна быть в тексте ошибки");
	assert.match(text, /Лог установки: .*install\.log/, "показываем путь к логу");
	assert.match(text, /urlopen error timed out/, "хвост лога тоже на экране");
});

await test("Запущенный сервер: кнопка остановки активна", async () => {
	const posts = [];
	const { box } = await renderLocalBox({
		...LOCAL_READY, serverRunning: true, pid: 4242
	}, posts);
	assert.match(textOf(box), /работает на порту 8765 \(pid 4242\)/);
	assert.equal(buttonByText(box, /Запустить сервер/).props.disabled, true);
	const stopBtn = buttonByText(box, /Остановить сервер/);
	assert.equal(stopBtn.props.disabled, false);
	await stopBtn.props.onClick();
	await flush();
	assert.deepEqual(posts, ["/dsh-voice-chat/local/stop"]);
});

await test("Голос локального Piper выбирается из списка имён моделей", () => {
	onChangeOf(tree, "Движок TTS")({ target: { value: "local" } });
	tree = renderOnce(Section, stub);
	const voice = controlByLabel(tree, "Голос (локальный Piper)");
	assert.equal(typeof voice.props.onChange, "function");
	voice.props.onChange({ target: { value: "ru_RU-denis-medium" } });
	tree = renderOnce(Section, stub);
	assert.equal(controlByLabel(tree, "Голос (локальный Piper)").props.value, "ru_RU-denis-medium");
});

console.log("\nУдаление локального движка");
await test("Кнопка удаления просит подтверждение и только потом дёргает /local/remove", async () => {
	const posts = [];
	const { box, rerender } = await renderLocalBox({ ...LOCAL_READY, hasFiles: true }, posts);
	const btn = buttonByText(box, /Удалить локальный движок/);
	assert.ok(btn, "кнопка удаления должна быть, когда на диске есть файлы");
	assert.equal(btn.props.disabled, false);
	assert.match(textOf(box), /освобождая обычно 1–3 ГБ/, "предупреждаем о размере");
	// Первый клик — только вопрос (перерисовываем тот же компонент: состояние живёт в нём)
	btn.props.onClick();
	await flush();
	assert.deepEqual(posts, [], "первый клик ничего не удаляет");
	const confirmBtn = buttonByText(await rerender(), /Точно удалить/);
	assert.ok(confirmBtn, "после первого клика кнопка спрашивает подтверждение");
	await confirmBtn.props.onClick();
	await flush();
	assert.deepEqual(posts, ["/dsh-voice-chat/local/remove"], "второй клик удаляет");
});

await test("Кнопка удаления неактивна, когда на диске ничего нет", async () => {
	const { box } = await renderLocalBox({ ...LOCAL_READY, hasFiles: false }, []);
	const btn = buttonByText(box, /Удалить локальный движок/);
	assert.ok(btn);
	assert.equal(btn.props.disabled, true, "нечего удалять");
});

console.log("\nОформление выпадающих списков");
await test("select получает color-scheme: без него нативный список белый", () => {
	for (const label of ["Движок ASR", "Движок TTS", "Язык речи"]) {
		const select = controlByLabel(tree, label);
		assert.equal(select.type, "select", label);
		assert.ok(select.props.style.colorScheme === "dark" || select.props.style.colorScheme === "light",
			label + ": у списка должен быть colorScheme, иначе список белый на тёмном фоне");
		assert.ok(select.props.style.background, label + ": нужен явный фон поля");
	}
});

console.log("\nКлавиша запуска распознавания");
const HOST_WITH_HOTKEY = { ...HOST_SETTINGS, asrHotkey: "Ctrl+Shift+M" };
/** Поле клавиши — input внутри блока (там же кнопки сброса). */
const hotkeyField = (t) => {
	const control = controlByLabel(t, "Клавиша запуска распознавания");
	let input = null;
	walk(control, (node) => { if (!input && node.type === "input") input = node; });
	assert.ok(input, "в поле клавиши должен быть input");
	return input;
};
const hotkeyKey = (t, init) => hotkeyField(t).props.onKeyDown({
	key: "", code: "", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
	preventDefault() { }, stopPropagation() { }, ...init
});

await test("Поле показывает текущую клавишу из настроек хоста", async () => {
	const stubH = createReactStub();
	const SectionH = await loadSettingsSection(stubH, () => Promise.resolve({
		ok: true, status: 200, json: () => Promise.resolve(HOST_WITH_HOTKEY)
	}));
	let t = renderOnce(SectionH, stubH);
	await flush();
	t = renderOnce(SectionH, stubH);
	t = renderOnce(SectionH, stubH);
	assert.equal(hotkeyField(t).props.value, "Ctrl + Shift + M");
	assert.equal(hotkeyField(t).props.readOnly, true, "поле не должно ловить обычный ввод текста");
});

await test("Хост без поля asrHotkey → значение по умолчанию «Правый Ctrl»", async () => {
	const stubD = createReactStub();
	const SectionD = await loadSettingsSection(stubD, () => Promise.resolve({
		ok: true, status: 200, json: () => Promise.resolve(HOST_SETTINGS)
	}));
	let t = renderOnce(SectionD, stubD);
	await flush();
	t = renderOnce(SectionD, stubD);
	t = renderOnce(SectionD, stubD);
	assert.equal(hotkeyField(t).props.value, "Правый Ctrl");
});

await test("Нажатие клавиши в поле запоминает сочетание", async () => {
	const stubH = createReactStub();
	const SectionH = await loadSettingsSection(stubH, () => Promise.resolve({
		ok: true, status: 200, json: () => Promise.resolve(HOST_SETTINGS)
	}));
	let t = renderOnce(SectionH, stubH);
	await flush();
	t = renderOnce(SectionH, stubH);
	t = renderOnce(SectionH, stubH);
	hotkeyKey(t, { key: "Control", code: "ControlRight", ctrlKey: true });
	t = renderOnce(SectionH, stubH);
	assert.equal(hotkeyField(t).props.value, "Правый Ctrl", "одиночный модификатор принимается");
	hotkeyKey(t, { key: "M", code: "KeyM", ctrlKey: true, altKey: true });
	t = renderOnce(SectionH, stubH);
	assert.equal(hotkeyField(t).props.value, "Ctrl + Alt + M");
});

await test("Esc возвращает «Правый Ctrl», Delete выключает клавишу", async () => {
	const stubH = createReactStub();
	const SectionH = await loadSettingsSection(stubH, () => Promise.resolve({
		ok: true, status: 200, json: () => Promise.resolve(HOST_SETTINGS)
	}));
	let t = renderOnce(SectionH, stubH);
	await flush();
	t = renderOnce(SectionH, stubH);
	t = renderOnce(SectionH, stubH);
	hotkeyKey(t, { key: "Escape", code: "Escape" });
	t = renderOnce(SectionH, stubH);
	assert.equal(hotkeyField(t).props.value, "Правый Ctrl");
	hotkeyKey(t, { key: "Delete", code: "Delete" });
	t = renderOnce(SectionH, stubH);
	assert.equal(hotkeyField(t).props.value, "не задана", "пустое значение = горячая клавиша выключена");
});

await test("Кнопки «Правый Ctrl» и «Выключить» меняют поле", async () => {
	const btns = [];
	walk(tree, (node) => { if (node.type === "button" && /Правый Ctrl|Выключить/.test(textOf(node))) btns.push(node); });
	assert.equal(btns.length, 2, "должны быть обе кнопки: " + btns.map(textOf).join(" | "));
	btns.find((b) => /Выключить/.test(textOf(b))).props.onClick();
	tree = renderOnce(Section, stub);
	assert.equal(hotkeyField(tree).props.value, "не задана");
	btns.find((b) => /Правый Ctrl/.test(textOf(b))).props.onClick();
	tree = renderOnce(Section, stub);
	assert.equal(hotkeyField(tree).props.value, "Правый Ctrl");
});

await test("Сохраняется выбранное сочетание", async () => {
	posts.length = 0;
	hotkeyKey(tree, { key: "M", code: "KeyM", ctrlKey: true, shiftKey: true });
	tree = renderOnce(Section, stub);
	let saveBtn = null;
	walk(tree, (node) => { if (!saveBtn && node.type === "button" && textOf(node).includes("Сохранить")) saveBtn = node; });
	saveBtn.props.onClick();
	await flush();
	assert.equal(posts[0].body.asrHotkey, "Ctrl+Shift+M");
	// возвращаем дефолт, чтобы не ломать следующие тесты
	hotkeyKey(tree, { key: "Escape", code: "Escape" });
	tree = renderOnce(Section, stub);
});

console.log(`\n${passed} пройдено${process.exitCode ? " (есть падения)" : ""}`);
