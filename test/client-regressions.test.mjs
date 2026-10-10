/**
 * Регрессионные тесты браузерной половины (lib/client.js) — по одному-два
 * теста на каждый недавно исправленный баг. Все тесты падают на ДО-фиксовом
 * коде (git show HEAD:lib/client.js) и проходят на текущем.
 *
 * Запуск:  node test/client-regressions.test.mjs
 *
 * Чтобы убедиться, что тест реально ловит баг, гоняем его и на старой версии:
 *   git show HEAD:lib/client.js > /tmp/prefix-client.js
 *   DSH_CLIENT_SRC=/tmp/prefix-client.js node test/client-regressions.test.mjs
 *
 * Стенд — тот же, что в test/client-settings.test.mjs: createReactStub +
 * loadSettingsSection + expandComponents + renderOnce + walk/textOf/
 * controlByLabel/buttonByText. Здесь стенд обобщён (окно, localStorage,
 * fetch-журнал, доступ к внутренним колбэкам VoiceChatButton).
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Позволяет гонять тесты на произвольной версии client.js (см. шапку файла).
const CLIENT_SRC = process.env.DSH_CLIENT_SRC
	? path.resolve(process.env.DSH_CLIENT_SRC)
	: path.join(HERE, "..", "lib", "client.js");

// ---------- 极简 React 桩（useState/useEffect/useRef/createElement 足够渲染) ----------
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
		useCallback(fn) { cursor++; return fn; },
		useMemo(fn) { cursor++; return fn(); }
	};
	return {
		React,
		beginRender() { cursor = 0; },
		/** Текущая позиция курсора хуков — сколько хуков съел последний render. */
		hookCursor() { return cursor; },
		resume(at) { cursor = at; },
		subRender(fn) {
			const saved = cursor;
			cursor = 0;
			try { return fn(); } finally { cursor = saved; }
		},
		runEffects() {
			for (const entry of effects) {
				if (!entry || !entry.pending) continue;
				entry.pending = false;
				entry.fn();
			}
		}
	};
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
/** 找到 field(label, control) 渲染出的控件，返回它的节点。 */
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
function onChangeOf(tree, labelText) {
	const control = controlByLabel(tree, labelText);
	assert.equal(typeof control.props.onChange, "function", `Поле «${labelText}» должно иметь onChange`);
	return control.props.onChange;
}
const buttonByText = (tree, re) => {
	let found = null;
	walk(tree, (node) => { if (!found && node.type === "button" && re.test(textOf(node))) found = node; });
	return found;
};
/** Узел-компонент с таким именем функции (React.createElement(SomeComponent)). */
function componentNamed(tree, name) {
	let found = null;
	walk(tree, (node) => {
		if (!found && typeof node.type === "function" && node.type.name === name) found = node;
	});
	return found;
}

/**
 * Раскрыть вложенные функциональные компоненты в дерево.
 * Узел-компонент СОХРАНЯЕМ (по нему тесты находят блоки по имени),
 * а его children заменяем результатом отрисовки.
 */
function expandComponents(el, stubX, depth = 0) {
	if (!el || typeof el !== "object" || depth > 8) return el;
	if (typeof el.type === "function") {
		let rendered = el;
		let guard = 0;
		while (rendered && typeof rendered === "object" && typeof rendered.type === "function" && guard++ < 8) {
			rendered = stubX.subRender(() => rendered.type(rendered.props));
		}
		stubX.runEffects();
		const inner = rendered && typeof rendered === "object" ? expandComponents(rendered, stubX, depth + 1) : [];
		return { type: el.type, props: el.props, children: [inner] };
	}
	return { ...el, children: (el.children || []).map((c) => expandComponents(c, stubX, depth + 1)) };
}

/** 渲染一次: обёртка → её тело → раскрытие вложенных компонентов. */
function renderOnce(Component, stubX) {
	stubX.beginRender();
	let el = Component({});
	if (el && typeof el.type === "function") el = el.type(el.props);
	stubX.runEffects();
	return expandComponents(el, stubX);
}

// ---------- 宿主 / settings ----------
const HOST_SETTINGS = {
	version: "0.7.0",
	asrEngine: "siliconflow",
	asrBaseUrl: "https://api.siliconflow.cn/v1",
	asrModel: "FunAudioLLM/SenseVoiceSmall",
	asrApiKey: "",
	autoSend: true,
	silenceMs: 2500,
	continuousMode: false,
	rewrite: false,
	ttsEngine: "edge",
	ttsVoice: "zh-CN-YunxiNeural",
	ttsBaseUrl: "",
	ttsModel: "",
	ttsApiKey: "",
	asrFallback: "",
	asrHotkey: "CtrlRight",
	speechLang: "ru-RU",
	ratePercent: 110,
	asrConfig: {},
	ttsConfig: {}
};

const flush = async (n = 20) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

// ---------- Audio-заглушка (playAudioBlob создаёт new Audio(blobUrl)) ----------
class AudioStub {
	constructor(src) { this.src = src; this.playbackRate = 1; this.onended = null; this.onerror = null; }
	play() {
		Promise.resolve().then(() => { if (this.onended) this.onended(); });
		return Promise.resolve();
	}
	pause() { /* noop */ }
}

/**
 * Журналирующий fetch: пишет {url, method, body} в calls, ответ — из handler.
 * handler(url, options) → объект ответа (уже промис-совместимый) или Promise.
 */
function recordingFetch(handler) {
	const calls = [];
	const impl = (url, options = {}) => {
		calls.push({
			url: String(url),
			method: options.method || "GET",
			headers: options.headers || null,
			body: options.body === undefined ? null : options.body
		});
		return Promise.resolve(handler(String(url), options));
	};
	return { impl, calls };
}
const jsonResponse = (data, status = 200) => ({
	ok: status >= 200 && status < 300,
	status,
	json: () => Promise.resolve(data),
	blob: () => Promise.resolve(new Blob(["audio"]))
});

/**
 * Подмена window.localStorage: length / key(i) / getItem / setItem.
 * map — объект исходных значений (строки), пишем в него же.
 */
function createLocalStorageStub(initial = {}) {
	const map = new Map(Object.entries(initial));
	return {
		map,
		get length() { return map.size; },
		key(i) { return Array.from(map.keys())[i] ?? null; },
		getItem(k) { return map.has(k) ? map.get(k) : null; },
		setItem(k, v) { map.set(k, String(v)); },
		removeItem(k) { map.delete(k); },
		clear() { map.clear(); }
	};
}

// ---------- Загрузка lib/client.js ----------
/**
 * Внутренние колбэки VoiceChatButton (sendText, playOne) — не экспортируются,
 * поэтому для тестов №2 и №3 делаем ИНСТРУМЕНТИРОВАННУЮ КОПИЮ исходника
 * (только в памяти, файл на диске не трогаем): объявление
 * `const sendText = useCallback(` превращается в
 * `const sendText = globalThis.__dshProbe.sendText = useCallback(`.
 * Само объявление сохраняется — иначе дальше по телу компонента будет ReferenceError
 * (TDZ). Если разметка исходника изменится — тест упадёт с внятной ошибкой,
 * а не молча промолчит.
 */
const PROBE_HOOKS = [
	["const sendText = useCallback(", "const sendText = globalThis.__dshProbe.sendText = useCallback("],
	["const playOne = useCallback(", "const playOne = globalThis.__dshProbe.playOne = useCallback("]
];

/**
 * Загрузить client.js и применить его.
 * opts.fetchImpl — окно.fetch; opts.localStorage — подмена window.localStorage;
 * opts.probes — ["sendText","playOne"]: открыть внутренние колбэки.
 * Возвращает { exports, sections, buttons, probe, windowStub }.
 */
async function loadClient(stub, opts = {}) {
	const src = await readFile(CLIENT_SRC, "utf8");
	let code = src;
	if (opts.probes) {
		globalThis.__dshProbe = {};
		for (const name of opts.probes) {
			const [from, to] = PROBE_HOOKS.find(([f]) => f.startsWith("const " + name + " "));
			assert.ok(from, "нет известной точки инструментации для " + name);
			const hits = code.split(from).length - 1;
			assert.equal(hits, 1,
				`ожидалась ровно одна точка «${from.trim()}», найдено ${hits} — `
				+ "исходник client.js изменился, инструментацию надо поправить");
			code = code.replace(from, to);
		}
	}

	let captured = null;
	const windowStub = {
		fetch: opts.fetchImpl || (() => Promise.resolve(jsonResponse({}))),
		setTimeout: () => 0,
		clearTimeout: () => {},
		setInterval: () => 0,
		clearInterval: () => {},
		addEventListener: () => {},
		removeEventListener: () => {},
		AudioContext: undefined,
		webkitAudioContext: undefined,
		// speechSynthesis намеренно НЕ задаём: последний рубеж озвучки обязан
		// честно вернуть false, иначе тесты не заметят провала серверных ступеней.
		__ModuleLoader__: { load(spec) { captured = spec; } }
	};
	if (opts.localStorage) windowStub.localStorage = opts.localStorage;

	const fn = new Function(
		"window", "console", "navigator", "setTimeout", "clearTimeout", "URL", "Audio",
		code
	);
	fn(windowStub, console, { mediaDevices: {} }, () => 0, () => {}, URL, AudioStub);
	assert.ok(captured && typeof captured.factory === "function",
		"client.js должен регистрировать factory через __ModuleLoader__.load");

	const exportsObj = captured.factory((name) => {
		if (name === "react") return stub.React;
		throw new Error("unexpected require: " + name);
	});
	assert.equal(typeof exportsObj.apply, "function");

	const sections = {};
	const buttons = {};
	const fakeSlots = {
		inject(name, fn) { return fn(); },
		register(meta, component) {
			(meta.name === "settings.section" ? sections : buttons)[meta.name] = component;
			return () => {};
		}
	};
	exportsObj.apply({
		get: (name) => (name === "slots" ? fakeSlots : undefined),
		inject: (deps, fn) => fn({ slots: fakeSlots, modelDirectories: null })
	});
	assert.equal(typeof sections["settings.section"], "function", "не зарегистрирован settings.section");
	assert.equal(typeof buttons["conversation.input.right"], "function", "не зарегистрирован conversation.input.right");
	return { exports: exportsObj, sections, buttons, probe: globalThis.__dshProbe, windowStub };
}

// ---------- Рендер формы настроек до «устоявшегося» состояния ----------
async function settleSettingsSection(stub, Section, hostSettings = HOST_SETTINGS) {
	const fetchImpl = opts => (opts && opts.method === "POST"
		? Promise.resolve(jsonResponse({ ok: true, settings: hostSettings }))
		: Promise.resolve(jsonResponse(hostSettings)));
	const loaded = await loadClient(stub, { fetchImpl });
	let tree = renderOnce(Section, stub);
	await flush();
	tree = renderOnce(Section, stub);
	tree = renderOnce(Section, stub);
	return { loaded, get tree() { return tree; }, set tree(v) { tree = v; } };
}

/**
 * Отрендерить блок локального движка с заданным статусом /local/status.
 * Хуки блока продолжают нумерацию после хуков формы — иначе useState блока
 * перезапишет состояние формы.
 */
async function renderLocalBox(statusBody, boxPosts = []) {
	const stubX = createReactStub();
	const fetchImpl = (url, options = {}) => {
		if (String(url).includes("/dsh-voice-chat/local/")) {
			if (options.method === "POST") {
				boxPosts.push(String(url));
				return Promise.resolve(jsonResponse({ ok: true, status: statusBody, alreadyDownloaded: false }));
			}
			return Promise.resolve(jsonResponse(statusBody));
		}
		return Promise.resolve(jsonResponse(HOST_SETTINGS));
	};
	const { sections } = await loadClient(stubX, { fetchImpl });
	const Section = sections["settings.section"];
	let t = renderOnce(Section, stubX);
	await flush();
	t = renderOnce(Section, stubX);
	onChangeOf(t, "Движок ASR")({ target: { value: "local" } });
	t = renderOnce(Section, stubX);
	const node = componentNamed(t, "LocalEngineBox");
	assert.ok(node, "блок локального движка должен рендериться при engine=local");

	const settle = () => flush(30);
	const mark = stubX.hookCursor();
	const draw = async () => {
		stubX.resume(mark);
		const box = node.type(node.props);
		stubX.runEffects();
		await settle();
		return box;
	};
	// два прохода: первый тянет статус, второй рисует уже пришедший
	let box = await draw();
	box = await draw();
	return { box, stub: stubX, rerender: draw };
}

const LOCAL_READY = {
	pythonReady: true, pythonPath: "python3", venvReady: true, modelsReady: true,
	serverRunning: false, installing: false, installStage: null, installError: null,
	port: 8765, pid: null, error: null, hasFiles: true, models: [], modelsBytes: 0,
	dataDir: "/home/u/.local/share/dsh-voice-chat"
};

// ---------- Мини-раннер ----------
let passed = 0;
let failed = 0;
async function test(name, fn) {
	try {
		await fn();
		passed += 1;
		console.log(`  ok  ${name}`);
	} catch (err) {
		failed += 1;
		console.error(`FAIL  ${name}`);
		console.error(String(err && err.stack ? err.stack : err).split("\n").slice(0, 6).join("\n"));
		process.exitCode = 1;
	}
}

// =====================================================================
// 1. React error #310 / серый экран настроек
// =====================================================================
console.log("React error #310: BrowserAsrCheckBlock — компонент, а не вызов из тела формы");

await test("Дерево settings.section содержит компонент BrowserAsrCheckBlock (а не инлайновый div)", async () => {
	const stub = createReactStub();
	const s = await settleSettingsSection(stub, (await loadClient(stub, {
		fetchImpl: () => Promise.resolve(jsonResponse(HOST_SETTINGS))
	})).sections["settings.section"]);
	let tree = s.tree;
	onChangeOf(tree, "Движок ASR")({ target: { value: "browser" } });
	tree = renderOnce((await loadClient(stub, {
		fetchImpl: () => Promise.resolve(jsonResponse(HOST_SETTINGS))
	})).sections["settings.section"], stub);

	const block = componentNamed(tree, "BrowserAsrCheckBlock");
	assert.ok(block,
		"в дереве должен быть УЗЕЛ-КОМПОНЕНТ с type.name === \"BrowserAsrCheckBlock\". "
		+ "До фикса здесь стоял прямой вызов browserAsrCheckBlock() из тела формы — "
		+ "её хуки принадлежали VoiceChatSettingsSection и появлялись условно "
		+ "(React error #310, серый экран настроек)");
	assert.match(textOf(block), /Проверить распознавание/, "блок должен содержать кнопку проверки");
});

await test("BrowserAsrCheckBlock — именно компонент: его состояние принадлежит ему, а не форме", async () => {
	const stub = createReactStub();
	const { sections } = await loadClient(stub, {
		fetchImpl: () => Promise.resolve(jsonResponse(HOST_SETTINGS))
	});
	let tree = renderOnce(sections["settings.section"], stub);
	await flush();
	tree = renderOnce(sections["settings.section"], stub);
	tree = renderOnce(sections["settings.section"], stub);
	onChangeOf(tree, "Движок ASR")({ target: { value: "browser" } });
	tree = renderOnce(sections["settings.section"], stub);

	const block = componentNamed(tree, "BrowserAsrCheckBlock");
	assert.ok(block, "нужен узел-компонент BrowserAsrCheckBlock");
	// Рендерим блок ОТДЕЛЬНО (subRender → курсор с 0): его useState обязаны
	// занять собственные слоты. Если бы блок был вызовом из тела формы,
	// такой «отдельный» рендер невозможен — хуки уже съедены родителем.
	const expanded = stub.subRender(() => expandComponents(block, stub));
	assert.match(textOf(expanded), /Проверить распознавание/);
	// Кнопка принадлежит блоку: клик меняет его собственное состояние
	const probeBtn = buttonByText(expanded, /Проверить распознавание/);
	assert.ok(probeBtn, "в блоке должна быть кнопка пробного сеанса");
	assert.equal(probeBtn.props.disabled, false);
});

await test("Число хуков VoiceChatSettingsSection одинаково для siliconflow и browser", async () => {
	const stub = createReactStub();
	const { sections } = await loadClient(stub, {
		fetchImpl: () => Promise.resolve(jsonResponse(HOST_SETTINGS))
	});
	let tree = renderOnce(sections["settings.section"], stub);
	await flush();
	tree = renderOnce(sections["settings.section"], stub);
	tree = renderOnce(sections["settings.section"], stub);

	/** Хуков, съеденных ОДНИМ вызовом тела VoiceChatSettingsSection. */
	const hooksFor = (engine) => {
		onChangeOf(tree, "Движок ASR")({ target: { value: engine } });
		tree = renderOnce(sections["settings.section"], stub);
		stub.beginRender();
		const el = sections["settings.section"]({});
		assert.equal(stub.hookCursor(), 0, "обёртка settings.section не должна использовать хуки");
		assert.equal(typeof el.type, "function", "обёртка должна отдавать элемент-компонент");
		el.type(el.props);                      // ← тело VoiceChatSettingsSection
		const used = stub.hookCursor();
		stub.runEffects();
		return used;
	};

	const baseline = hooksFor("siliconflow");
	const withBrowser = hooksFor("browser");
	assert.equal(withBrowser, baseline,
		`engine=browser съел ${withBrowser - baseline} лишних хуков (${baseline} → ${withBrowser}). `
		+ "Условные хуки в теле компонента = React error #310 при переключении движка: "
		+ "порядок хуков едет и React роняет всё дерево настроек");

	// Round-trip: уйти и вернуться — порядок хуков тоже обязан совпасть
	const back = hooksFor("siliconflow");
	assert.equal(back, baseline, "после возврата на siliconflow число хуков изменилось");
	assert.equal(hooksFor("browser"), withBrowser, "повторный browser дал другое число хуков");
	// Соседние сетевые движки — для контроля, что счётчик вообще живой
	assert.equal(hooksFor("groq"), baseline, "у groq должно быть столько же хуков, сколько у siliconflow");
});

// =====================================================================
// 2. sendText никогда не передаёт хосту не-строку
// =====================================================================
console.log("\nsendText: в setDraft хоста уходит только строка");

/** Живой стенд кнопки микрофона с настоящим VoiceChatButton внутри. */
async function mountButton(hostSettings) {
	const stub = createReactStub();
	const setDraftCalls = [];
	const submitCalls = [];
	const inputActions = {
		// Ровно то, что делает хост: text.replace(...) — любая не-строка падает.
		setDraft(v) { setDraftCalls.push(v); return String(v).replace(/\s+/g, " "); },
		submit() { submitCalls.push(true); }
	};
	const loaded = await loadClient(stub, {
		fetchImpl: () => Promise.resolve(jsonResponse(hostSettings)),
		probes: ["sendText"]
	});
	// Хост отдаёт кнопке именно эти пропсы (conversation.input.right)
	const props = {
		sessionId: "session-1",
		useSession: (sel) => sel({ running: false }),
		useInput: (sel) => sel({ draft: "" }),
		inputActions
	};
	const render = async () => {
		stub.beginRender();
		const el = loaded.buttons["conversation.input.right"](props);
		// Обёртка создаёт useCurrentModel; тело — сам VoiceChatButton
		const inner = el.type(el.props);
		stub.runEffects();
		return inner;
	};
	await render();
	await flush();
	stub.runEffects();
	await flush();
	await render();   // настройки доехали → эффекты проставили autoSendRef
	stub.runEffects();
	await flush();
	return {
		stub,
		render,
		props,
		inputActions,
		setDraftCalls,
		submitCalls,
		sendText: () => loaded.probe.sendText
	};
}

await test("setDraft получает строку: распознавание вернуло объект, а не текст", async () => {
	const h = await mountButton(HOST_SETTINGS);
	assert.equal(typeof h.sendText(), "function", "внутренний sendText должен быть доступен");
	// Хостный setDraft делает text.replace(...) — любое не-строковое значение
	// роняло весь ввод сессии в error boundary. Именно этот стенд так и делает.
	const transcripts = [
		["строка", "Привет, как дела?"],
		["строка с пробелами по краям", "  Повторите вопрос  "],
		["число", 42],
		["объект результата распознавания", { text: "привет", confidence: 0.9 }],
		["массив", ["раз", "два"]],
		["null", null],
		["undefined", undefined],
		["логическое", true]
	];
	for (const [what, value] of transcripts) {
		h.setDraftCalls.length = 0;
		h.submitCalls.length = 0;
		h.sendText()(value);           // setDraft упадёт на не-строке → тест упадёт
		for (const got of h.setDraftCalls) {
			assert.equal(typeof got, "string",
				`setDraft получил ${typeof got} (${what}) — хост сделает text.replace() и уронит ввод сессии`);
		}
		// Ничего не «потерялось»: значение либо ушло строкой, либо отброшено как пустое
		const sent = h.setDraftCalls[0];
		assert.ok(sent === undefined || typeof sent === "string");
	}
	// Автоотправка — по настройке (autoSend=true у хоста по умолчанию)
	h.setDraftCalls.length = 0;
	h.submitCalls.length = 0;
	h.sendText()(42);
	assert.equal(h.setDraftCalls.length, 1, "число тоже должно дойти до поля ввода");
	assert.equal(typeof h.setDraftCalls[0], "string");
	assert.equal(h.submitCalls.length, 1, "autoSend=true → submit вызван");
});

await test("Пустое значение не отправляется и не падает", async () => {
	const h = await mountButton(HOST_SETTINGS);
	for (const value of ["", "   ", "\n\t", null, undefined, []]) {
		h.setDraftCalls.length = 0;
		h.submitCalls.length = 0;
		h.sendText()(value);
		assert.deepEqual(h.setDraftCalls, [], `${JSON.stringify(value) ?? String(value)} → setDraft не должен вызываться`);
		assert.deepEqual(h.submitCalls, [], "пустой текст отправлять нельзя");
	}
});

await test("autoSend=false: строка попадает в поле, submit не вызывается", async () => {
	const h = await mountButton({ ...HOST_SETTINGS, autoSend: false, continuousMode: false });
	h.setDraftCalls.length = 0;
	h.submitCalls.length = 0;
	h.sendText()({ text: "черновик" });
	assert.equal(h.setDraftCalls.length, 1, "текст должен оказаться в поле ввода");
	assert.equal(typeof h.setDraftCalls[0], "string");
	assert.deepEqual(h.submitCalls, [], "autoSend выключен — отправлять нельзя");
});

// =====================================================================
// 3. Озвучка: запасная ступень — POST, а не GET ?text=
// =====================================================================
console.log("\nЗапасная озвучка: POST /tts с телом, а не GET ?text=");

await test("Вторая ступень озвучки шлёт POST /dsh-voice-chat/tts с JSON-телом {text}", async () => {
	const long = "Ответ модели. ".repeat(300).trim();     // > 3000 символов
	assert.ok(long.length > 3000, "нужен длинный ответ, иначе тест не про Query-Length Limit");

	const { impl, calls } = recordingFetch((url, options) => {
		if (url.startsWith("/dsh-voice-chat/speak")) {
			// edge-tts упал — сценарий, ради которого существует вторая ступень
			return jsonResponse({ error: "edge-tts недоступен" }, 502);
		}
		if (url.startsWith("/dsh-voice-chat/tts")) return jsonResponse({ audio: "mp3" });
		return jsonResponse(HOST_SETTINGS);
	});
	const stub = createReactStub();
	const loaded = await loadClient(stub, { fetchImpl: impl, probes: ["playOne"] });
	stub.beginRender();
	const el = loaded.buttons["conversation.input.right"]({});
	el.type(el.props);
	stub.runEffects();
	await flush();
	stub.runEffects();
	await flush();
	stub.beginRender();
	const el2 = loaded.buttons["conversation.input.right"]({});
	el2.type(el2.props);
	stub.runEffects();
	await flush();

	const played = await loaded.probe.playOne(long);
	assert.equal(played, true, "длинный ответ должен озвучиваться (хост вернул аудио)");

	const speak = calls.find((c) => c.url.startsWith("/dsh-voice-chat/speak"));
	assert.ok(speak, "первая ступень — /speak");
	const ttsCalls = calls.filter((c) => c.url.startsWith("/dsh-voice-chat/tts"));
	assert.equal(ttsCalls.length, 1, "запасная ступень должна позвать /tts ровно один раз");
	const tts = ttsCalls[0];

	assert.equal(tts.url.split("?")[0], "/dsh-voice-chat/tts",
		`адрес не должен содержать query string (получено ${tts.url.length} символов вместо 20): `
		+ "длинный ответ целиком в ?text= упирался в лимит длины URL");
	assert.doesNotMatch(tts.url, /\?/, "в URL запасной ступени не должно быть query-строки");
	assert.doesNotMatch(tts.url, /text=/, "текст не должен уезжать в ?text=");
	assert.ok(tts.url.length < 100,
		"URL должен остаться коротким: " + tts.url.length + " символов — текст уехал в адрес");
	assert.equal(tts.method, "POST", "запасная ступень обязана быть POST");
	assert.ok(tts.headers && /application\/json/i.test(tts.headers["Content-Type"] || ""),
		"нужен Content-Type: application/json");
	assert.equal(JSON.parse(tts.body).text, long, "текст должен уйти в JSON-теле {text}");
	assert.deepEqual(Object.keys(JSON.parse(tts.body)), ["text"]);
});

// =====================================================================
// 4. Кнопка докачивания модели локального движка
// =====================================================================
console.log("\nЛокальный движок: кнопка докачивания выбранной модели");

await test("Кнопка «Докачать модель» шлёт POST /local/download-model?model=<выбранная>", async () => {
	const posts = [];
	const { box } = await renderLocalBox({
		...LOCAL_READY, modelsReady: false, whisperModel: "base", piperVoice: "ru_RU-irina-medium"
	}, posts);
	const btn = buttonByText(box, /Докачать модель/);
	assert.ok(btn, "нужна кнопка докачивания модели (её раньше не было вовсе)");
	assert.equal(btn.props.disabled, false, "venv есть, модели нет — кнопка активна");
	await btn.props.onClick();
	await flush();
	assert.deepEqual(posts, ["/dsh-voice-chat/local/download-model?model=base"],
		"сервер берёт модель из настроек: без кнопки /stt ушёл бы на модель, которой нет на диске");
});

await test("Пока идёт скачивание, кнопка заблокирована", async () => {
	let release;
	const pending = new Promise((res) => { release = res; });
	const posts = [];
	const stub = createReactStub();
	let downloaded = false;   // статус /local/status отражает факт скачивания
	const fetchImpl = (url, options = {}) => {
		if (String(url).includes("/local/download-model")) { posts.push(String(url)); return pending; }
		if (String(url).includes("/dsh-voice-chat/local/")) {
			if (options.method === "POST") return Promise.resolve(jsonResponse({ ok: true, status: LOCAL_READY }));
			return Promise.resolve(jsonResponse({ ...LOCAL_READY, modelsReady: downloaded, whisperModel: "medium" }));
		}
		return Promise.resolve(jsonResponse(HOST_SETTINGS));
	};
	const { sections } = await loadClient(stub, { fetchImpl });
	const Section = sections["settings.section"];
	let t = renderOnce(Section, stub);
	await flush();
	t = renderOnce(Section, stub);
	onChangeOf(t, "Движок ASR")({ target: { value: "local" } });
	t = renderOnce(Section, stub);
	const node = componentNamed(t, "LocalEngineBox");
	assert.ok(node, "блок локального движка должен быть");
	const mark = stub.hookCursor();
	const draw = async () => {
		stub.resume(mark);
		const box = node.type(node.props);
		stub.runEffects();
		await flush(10);
		return box;
	};
	let box = await draw();
	box = await draw();          // второй проход: статус уже пришёл
	const btn = buttonByText(box, /Докачать модель/);
	assert.ok(btn, "кнопка докачивания должна быть");
	assert.equal(btn.props.disabled, false, "venv есть, модели нет — кнопка активна");

	btn.props.onClick();          // НЕ await: запрос ещё висит
	await flush(5);
	assert.deepEqual(posts, ["/dsh-voice-chat/local/download-model?model=medium"]);
	box = await draw();
	const busy = buttonByText(box, /Скачивание|Докачать модель/);
	assert.ok(busy, "кнопка на месте");
	assert.match(textOf(busy), /Скачивание/, "на время загрузки кнопка должна это показывать");
	assert.equal(busy.props.disabled, true, "повторный клик во время загрузки нельзя допустить");

	downloaded = true;
	release(jsonResponse({ ok: true, status: LOCAL_READY }));
	await flush();
	box = await draw();
	assert.match(textOf(buttonByText(box, /Докачать модель/)), /^Докачать модель$/,
		"после загрузки кнопка снова в обычном состоянии");
	assert.equal(buttonByText(box, /Докачать модель/).props.disabled, true,
		"модель скачана (modelsReady) — кнопка снова неактивна");
});

// =====================================================================
// 5. repairPersistedDrafts
// =====================================================================
console.log("\nrepairPersistedDrafts: битые сохранённые черновики чинятся до рендера");

await test("apply() приводит нестроковый draft к строке и не трогает чужие ключи", async () => {
	const ls = createLocalStorageStub({
		"dsh.conversation.undef": JSON.stringify({ draft: undefined, view: null }),   // JSON выкинет draft
		"dsh.conversation.null": JSON.stringify({ draft: null, view: "chat" }),
		"dsh.conversation.num": JSON.stringify({ draft: 42 }),
		"dsh.conversation.obj": JSON.stringify({ draft: { text: "привет" } }),
		"dsh.conversation": JSON.stringify({ view: "chat" }),                          // без draft
		"dsh.conversation.arr": JSON.stringify([1, 2, 3]),
		"dsh.conversation.ok": JSON.stringify({ draft: "черновик", view: "chat" }),    // строковый — не трогаем
		"dsh.settings.cache": JSON.stringify({ draft: 7 }),
		"dsh.conversationUI.state": JSON.stringify({ draft: 7 }),
		"dsh.unrelated": JSON.stringify({ draft: 7 }),
		"dsh.conversation.broken": "{это не json",
		"dsh.conversation.empty": ""
	});
	const before = Object.fromEntries(ls.map);

	const stub = createReactStub();
	await loadClient(stub, { localStorage: ls, fetchImpl: () => Promise.resolve(jsonResponse(HOST_SETTINGS)) });

	const read = (k) => JSON.parse(ls.getItem(k));
	for (const key of ["dsh.conversation.undef", "dsh.conversation.null", "dsh.conversation.num",
		"dsh.conversation.obj", "dsh.conversation"]) {
		const data = read(key);
		assert.equal(typeof data.draft, "string",
			`в ${key} draft должен стать строкой — иначе хранилище хоста отдаст storedDraft === undefined, `
			+ "условие монтирования пройдёт, и setDraft(undefined) уронит ввод сессии "
			+ "(«text.replace is not a function»)");
	}
	assert.equal(read("dsh.conversation.arr").draft, "", "массив вместо объекта → безопасная заглушка");
	// Содержимое остальное не теряем
	assert.equal(read("dsh.conversation.null").view, "chat");
	assert.equal(read("dsh.conversation.obj").draft.text, undefined);
	assert.equal(typeof read("dsh.conversation.obj").draft, "string");

	// Нетронутые ключи — побайтово те же
	for (const key of ["dsh.settings.cache", "dsh.conversationUI.state", "dsh.unrelated",
		"dsh.conversation.ok", "dsh.conversation.broken", "dsh.conversation.empty"]) {
		assert.equal(ls.getItem(key), before[key], `ключ ${key} не должен переписываться`);
	}
	assert.equal(read("dsh.conversation.ok").draft, "черновик", "готовый черновик должен сохраниться");
});

await test("Битый JSON и приватный режим не роняют apply()", async () => {
	// getItem бросает — как в приватном режиме / при переполнении квоты
	const hostile = {
		length: 1,
		key: () => "dsh.conversation.x",
		getItem() { throw new Error("SecurityError: доступ к хранилищу запрещён"); },
		setItem() { throw new Error("SecurityError"); }
	};
	const stub = createReactStub();
	const loaded = await loadClient(stub, {
		localStorage: hostile,
		fetchImpl: () => Promise.resolve(jsonResponse(HOST_SETTINGS))
	});
	assert.equal(typeof loaded.sections["settings.section"], "function",
		"apply() обязан пережить недоступное хранилище и всё равно зарегистрировать слоты");

	// Совсем без localStorage
	const stub2 = createReactStub();
	const loaded2 = await loadClient(stub2, { fetchImpl: () => Promise.resolve(jsonResponse(HOST_SETTINGS)) });
	assert.equal(typeof loaded2.sections["settings.section"], "function");
});

// =====================================================================
// 6. Честная строка статуса локального движка
// =====================================================================
console.log("\nСтрока статуса показывает реальные модель и голос из /local/status");

await test("LocalEngineBox показывает state.whisperModel и state.piperVoice, а не константы", async () => {
	const { box } = await renderLocalBox({
		...LOCAL_READY, modelsReady: true, whisperModel: "large-v3", piperVoice: "ru_RU-denis-medium"
	}, []);
	const text = textOf(box);
	assert.match(text, /Модели/, "строка про модели обязана быть");
	assert.match(text, /faster-whisper\s+large-v3/,
		"названа модель из /local/status. Раньше тут была константа из ASR_ENGINE_DEFAULTS — "
		+ "пользователь видел «small», даже когда реально работала на другой");
	assert.match(text, /Piper\s+ru_RU-denis-medium/,
		"назван голос из /local/status (раньше был зашит ru_RU-irina-medium)");
	assert.doesNotMatch(text, /Piper\s+ru_RU-irina-medium/,
		"зашитый голос выдаёт себя за текущий — это враньё в статусе");
});

await test("При отсутствии полей в статусе остаются разумные значения по умолчанию", async () => {
	const { box } = await renderLocalBox({ ...LOCAL_READY }, []);
	const text = textOf(box);
	assert.match(text, /faster-whisper\s+small/, "без whisperModel показываем дефолт движка");
	assert.match(text, /Piper\s+ru_RU-irina-medium/, "без piperVoice показываем дефолтный голос");
});

console.log(`\n${passed} пройдено, ${failed} провалено${process.exitCode ? "" : " — все зелёные"}`);
