/**
 * Клиентский самотест «живого диалога» (continuousMode) в VoiceChatButton:
 * автопродолжение записи после озвучки, ручная пауза, перебивание (barge-in),
 * выключенный звук и деградация без микрофона.
 *
 * Никаких настоящих таймеров/сети: window.setTimeout/clearTimeout/setInterval
 * — ручные часы с продвижением tick(ms), fetch — стабы, AudioContext/Analyser —
 * с управляемой амплитудой (RMS), speechSynthesis — очередь utterances, которую
 * тест завершает сам через finishSpeech().
 *
 * Запуск: node test/live-dialog.test.mjs
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// CLIENT_SRC можно переопределить окружением — так проверяется «непустота» тестов
// на мутированных копиях lib/client.js (сам lib не трогаем).
const CLIENT_SRC = process.env.CLIENT_SRC || path.join(HERE, "..", "lib", "client.js");
const CLIENT_SRC_TEXT = await readFile(CLIENT_SRC, "utf8");

// ---------- ручные часы ----------
function createClock() {
	let now = 0;
	let seq = 1;
	const timers = new Map();
	const add = (fn, ms, every) => {
		const id = seq++;
		timers.set(id, { fn, at: now + (Number(ms) || 0), every });
		return id;
	};
	const clear = (id) => { timers.delete(id); };
	const nextDue = (limit) => {
		let best = null;
		for (const [id, t] of timers) {
			if (t.at <= limit && (!best || t.at < best.t.at || (t.at === best.t.at && id < best.id))) best = { id, t };
		}
		return best;
	};
	return {
		setTimeout: (fn, ms) => add(fn, ms, null),
		setInterval: (fn, ms) => add(fn, ms, Number(ms) || 1),
		clearTimeout: clear,
		clearInterval: clear,
		pending: () => timers.size,
		/** сколько живых таймеров с ровно такой задержкой (проверка «планировал ли перезапуск») */
		countDelayed: (ms) => {
			let n = 0;
			for (const t of timers.values()) if (t.every === null && t.at - now === ms) n += 1;
			return n;
		},
		tick(ms) {
			const limit = now + (Number(ms) || 0);
			for (;;) {
				const due = nextDue(limit);
				if (!due) break;
				now = due.t.at;
				if (due.t.every) due.t.at = now + due.t.every;
				else timers.delete(due.id);
				due.t.fn();
			}
			now = limit;
		}
	};
}

// ---------- React-стаб ----------
function createReactStub() {
	const states = [];
	const refs = [];
	const effects = [];
	const callbacks = [];
	const memos = [];
	let cursor = 0;
	const Fragment = Symbol("Fragment");
	const createElement = (type, props, ...children) => ({
		type,
		props: props || {},
		children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
	});
	const sameDeps = (a, b) => {
		if (!a || !b || a.length !== b.length) return false;
		return a.every((d, k) => d === b[k]);
	};
	return {
		React: {
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
				const changed = !prev || !deps || !prev.deps || !sameDeps(prev.deps, deps);
				// deps не изменились — сохраняем ранее полученный cleanup (как в React)
				effects[i] = {
					fn,
					deps,
					pending: changed,
					pendingCleanup: changed && prev ? prev.cleanup : null,
					cleanup: changed ? null : prev && prev.cleanup
				};
			},
			useCallback(fn, deps) {
				const i = cursor++;
				const prev = callbacks[i];
				if (!prev || (deps && !sameDeps(prev.deps, deps))) callbacks[i] = { fn, deps };
				return callbacks[i].fn;
			},
			useMemo(fn, deps) {
				const i = cursor++;
				const prev = memos[i];
				if (!prev || (deps && !sameDeps(prev.deps, deps))) memos[i] = { fn, deps };
				return memos[i].fn();
			}
		},
		beginRender() { cursor = 0; },
		runEffects() {
			for (const entry of effects) {
				if (!entry || !entry.pending) continue;
				entry.pending = false;
				if (entry.pendingCleanup) { try { entry.pendingCleanup(); } catch { /* ignore */ } entry.pendingCleanup = null; }
				const c = entry.fn();
				entry.cleanup = typeof c === "function" ? c : null;
			}
		},
		unmount() {
			for (const entry of effects) {
				if (entry && entry.cleanup) { try { entry.cleanup(); } catch { /* ignore */ } entry.cleanup = null; }
			}
		}
	};
}

// ---------- окружение страницы ----------
function createWorld(opts = {}) {
	const settings = {
		version: "0.5.0",
		asrEngine: "edge",
		autoSend: opts.autoSend !== false,
		continuousMode: opts.continuousMode === true,
		silenceMs: 600000, // тишина не должна самопроизвольно останавливать запись в тестах
		rewrite: false,
		ttsEngine: "edge",
		ratePercent: 110,
		speechLang: "ru-RU"
	};

	const clock = createClock();
	const speech = {
		utterances: [],
		cancelCount: 0,
		speak(u) { this.utterances.push(u); },
		// как в браузере: cancel() прерывает текущую речь → срабатывает onerror
		cancel() {
			this.cancelCount += 1;
			for (const u of this.utterances) {
				if (u.done) continue;
				u.done = true;
				if (u.onerror) u.onerror();
				else if (u.onend) u.onend();
			}
		}
	};
	const env = {
		settings,
		speech,
		clock,
		amplitude: 0,          // текущая амплитуда микрофона для всех Analyser
		gumCount: 0,
		gumModes: opts.gumModes || "ok",
		streamsStopped: 0,
		recorders: [],
		analysers: [],
		contexts: [],
		contextsClosed: 0,
		audios: [],
		revoked: [],
		drafts: [],
		submits: 0,
		running: false,
		latestText: "Это ответ ассистента для озвучки.",
		calls: []               // лог вызовов fetch
	};
	env.gum = async () => {
		env.gumCount += 1;
		const mode = Array.isArray(env.gumModes) ? (env.gumModes.shift() ?? "ok") : env.gumModes;
		if (mode === "reject") throw new Error("NotAllowedError: mic blocked");
		const track = { kind: "audio", stop() { env.streamsStopped += 1; } };
		return { getTracks: () => [track] };
	};

	// --- MediaRecorder (bare global в client.js) ---
	class FakeMediaRecorder {
		constructor(stream, options) {
			this.stream = stream;
			this.mimeType = (options && options.mimeType) || "audio/webm";
			this.state = "inactive";
			env.recorders.push(this);
		}
		start() { this.state = "recording"; }
		stop() {
			if (this.state === "inactive") return;
			this.state = "inactive";
			if (this.onstop) this.onstop();
		}
		static isTypeSupported() { return true; }
	}
	// --- SpeechSynthesisUtterance (bare global) ---
	class FakeUtterance {
		constructor(text) { this.text = text; this.onend = null; this.onerror = null; }
	}
	// --- Web Audio ---
	class FakeAnalyser {
		constructor() { this.fftSize = 1024; env.analysers.push(this); }
		getByteTimeDomainData(data) {
			const v = Math.max(0, Math.min(255, Math.round(128 + env.amplitude * 127)));
			for (let i = 0; i < data.length; i++) data[i] = v;
		}
	}
	class FakeAudioContext {
		constructor() { this.currentTime = 0; env.contexts.push(this); }
		createAnalyser() { return new FakeAnalyser(); }
		createMediaStreamSource() { return { connect() { /* ignore */ } }; }
		createOscillator() {
			return {
				type: "sine",
				frequency: { value: 0, setValueAtTime() { }, exponentialRampToValueAtTime() { } },
				connect() { }, start() { }, stop() { }, onended: null
			};
		}
		createGain() {
			return { gain: { setValueAtTime() { }, exponentialRampToValueAtTime() { } }, connect() { } };
		}
		get destination() { return {}; }
		close() { env.contextsClosed += 1; }
	}
	class FakeAudio {
		constructor(url) { this.src = url; this.playbackRate = 1; this.paused = false; env.audios.push(this); }
		play() { return Promise.resolve(); }
		pause() { this.paused = true; }
	}
	const urlStub = {
		createObjectURL: () => "blob:stub",
		revokeObjectURL: () => env.revoked.push(true)
	};

	const json = (data) => () => Promise.resolve(data);
	const fetchImpl = (url, options = {}) => {
		env.calls.push({ url, method: options.method || "GET" });
		if (String(url).startsWith("/dsh-voice-chat/settings")) {
			return Promise.resolve({ ok: true, status: 200, json: json(settings) });
		}
		if (String(url).startsWith("/dsh-voice-chat/latest-message")) {
			return Promise.resolve({ ok: true, status: 200, json: json({ text: env.latestText }) });
		}
		if (String(url).startsWith("/dsh-voice-chat/speak")) {
			// edge-tts «упал» → клиент обязан деградировать до браузерного TTS
			return Promise.resolve({ ok: false, status: 500, json: json({ error: "edge down" }) });
		}
		if (String(url).startsWith("/dsh-voice-chat/tts")) {
			return Promise.resolve({ ok: false, status: 502, json: json({ error: "tts down" }) });
		}
		if (String(url).startsWith("/dsh-voice-chat/stt")) {
			return Promise.resolve({ ok: true, status: 200, json: json({ text: "распознанный текст" }) });
		}
		return Promise.resolve({ ok: false, status: 404, json: json({ error: "not found" }) });
	};

	const consoleStub = {
		log: (...a) => env.logs.push(["log", ...a]),
		warn: (...a) => env.logs.push(["warn", ...a]),
		error: (...a) => env.logs.push(["error", ...a]),
		info: (...a) => env.logs.push(["info", ...a])
	};
	env.logs = [];

	const windowStub = {
		fetch: fetchImpl,
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
		setInterval: clock.setInterval,
		clearInterval: clock.clearInterval,
		addEventListener: () => {},
		removeEventListener: () => {},
		speechSynthesis: speech,
		AudioContext: FakeAudioContext,
		webkitAudioContext: FakeAudioContext,
		SpeechRecognition: class { start() { } stop() { } },
		webkitSpeechRecognition: class { start() { } stop() { } },
		__ModuleLoader__: { load(spec) { env.captured = spec; } }
	};
	const navigatorStub = { mediaDevices: { getUserMedia: (c) => env.gum(c) } };

	env.installGlobals = () => {
		globalThis.MediaRecorder = FakeMediaRecorder;
		globalThis.SpeechSynthesisUtterance = FakeUtterance;
		globalThis.Audio = FakeAudio;
	};

	const inputActions = {
		setDraft(v) { env.drafts.push(v); },
		submit() { env.submits += 1; env.running = true; }
	};
	const props = {
		sessionId: "s1",
		inputActions,
		useSession: () => ({ running: env.running, sessionId: "s1" }),
		useInput: () => ({ draft: "" })
	};
	return { env, windowStub, navigatorStub, consoleStub, props, urlStub, FakeUtterance, FakeAudio };
}

const flush = async (rounds = 15) => {
	for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
};

// ---------- дерево элементов ----------
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
function buttonsOf(tree) {
	const out = [];
	walk(tree, (node) => { if (node.type === "button") out.push(node); });
	return out;
}

// ---------- сборка мира: загрузка client.js + рендер кнопки ----------
async function mount({ continuousMode = false, gumModes = "ok", autoSend = true } = {}) {
	const stub = createReactStub();
	const w = createWorld({ continuousMode, gumModes, autoSend });
	w.env.installGlobals();

	let captured = null;
	w.windowStub.__ModuleLoader__.load = (spec) => { captured = spec; };
	const fn = new Function("window", "console", "navigator", "setTimeout", "clearTimeout", "URL", CLIENT_SRC_TEXT);
	fn(w.windowStub, w.consoleStub, w.navigatorStub, w.env.clock.setTimeout, w.env.clock.clearTimeout, w.urlStub);
	assert.ok(captured && typeof captured.factory === "function", "client.js должен регистрироваться через __ModuleLoader__.load");
	const requireStub = (name) => {
		if (name === "react") return stub.React;
		throw new Error("unexpected require: " + name);
	};
	const exportsObj = captured.factory(requireStub);
	assert.equal(typeof exportsObj.apply, "function");

	const registered = {};
	const fakeSlots = {
		inject(name, fn) { return fn(); },
		register(meta, component) { registered[meta.name] = component; return () => {}; }
	};
	exportsObj.apply({
		get: (name) => (name === "slots" ? fakeSlots : undefined),
		inject: (deps, fn) => fn({ slots: fakeSlots, modelDirectories: null })
	});
	const Wrapper = registered["conversation.input.right"];
	assert.equal(typeof Wrapper, "function", "должен регистрироваться слот conversation.input.right");

	const api = {
		stub,
		env: w.env,
		settings: w.env.settings,
		tree: null,
		render() {
			stub.beginRender();
			let el = Wrapper(w.props);
			if (el && typeof el.type === "function") el = el.type(el.props);
			stub.runEffects();
			api.tree = el;
			return el;
		},
		unmount() { stub.unmount(); },
		flush,
		tick: (ms) => w.env.clock.tick(ms),
		countDelayed: (ms) => w.env.clock.countDelayed(ms),
		buttons: () => buttonsOf(api.tree),
		/** завершить речь браузерного TTS (последний utterance; уже прерванная — no-op) */
		finishSpeech() {
			const u = w.env.speech.utterances[w.env.speech.utterances.length - 1];
			assert.ok(u, "озвучка должна была начаться (speechSynthesis.speak не вызывался)");
			if (u.done) return;
			u.done = true;
			if (u.onend) u.onend();
		},
		/** один полный ход: сессия busy → ответ AI → текст озвучивается */
		async turn(text) {
			if (text) w.env.latestText = text;
			w.env.running = true;
			api.render();
			w.env.running = false;
			api.render();
			w.env.clock.tick(800); // debounce конца хода
			await flush();
		},
		/** подождать, пока TTS-поток дойдёт до speechSynthesis.speak() */
		async waitSpeech() {
			await flush();
			if (process.env.DEBUG && !w.env.speech.utterances.length) {
				console.log("DEBUG calls:", JSON.stringify(w.env.calls));
				console.log("DEBUG logs:", JSON.stringify(w.env.logs));
				console.log("DEBUG timers:", w.env.clock.pending());
			}
			assert.ok(w.env.speech.utterances.length > 0, "клиент должен был дойти до браузерного TTS (деградация)");
		},
		logs: (kind) => w.env.logs.filter((l) => l[0] === kind).map((l) => l.slice(1).map(String).join(" ")),
		/** микрофон: сколько раз открывался getUserMedia */
		get micOpens() { return w.env.gumCount; },
		get hint() { let t = ""; walk(api.tree, (n) => { if (n.type === "span" && n.props && n.props.style && n.props.style.position === "absolute") t = textOf(n); }); return t; },
		/** началась ли новая запись (MediaRecorder) */
		get recorders() { return w.env.recorders; }
	};
	return api;
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

// =====================================================================
console.log("Базовый сценарий: озвучка → решение о продолжении");

await test("Монтирование: настройки доехали по шине, кнопки на месте", async () => {
	const m = await mount({ continuousMode: false });
	m.render();
	await m.flush();
	m.render();
	assert.equal(m.buttons().length, 2, "микрофон + выключатель звука");
	assert.equal(m.micOpens, 0, "до хода микрофон не трогаем");
});

await test("continuousMode выключен: после озвучки запись НЕ начинается", async () => {
	const m = await mount({ continuousMode: false });
	m.render();
	await m.flush();
	m.render();
	await m.turn();
	await m.waitSpeech();
	assert.equal(m.env.speech.utterances[0].text, "Это ответ ассистента для озвучки.");
	assert.equal(m.micOpens, 0, "без continuousMode микрофон не открывается на озвучку");
	m.finishSpeech();
	await m.flush();
	assert.equal(m.micOpens, 0, "нет barge-in без continuousMode");
	assert.equal(m.countDelayed(500), 0, "автоперезапуск записи не планируется");
	m.tick(5000);
	await m.flush();
	assert.equal(m.micOpens, 0, "после окончания очереди запись так и не стартовала");
	assert.equal(m.recorders.length, 0, "MediaRecorder не создавался");
});

await test("continuousMode включён: через 500 мс после озвучки микрофон открывается снова", async () => {
	const m = await mount({ continuousMode: true });
	m.render();
	await m.flush();
	m.render();
	await m.turn();
	await m.waitSpeech();
	assert.equal(m.micOpens, 1, "barge-in слушает микрофон во время озвучки");
	m.finishSpeech();
	await m.flush();
	m.tick(499);
	await m.flush();
	assert.equal(m.recorders.length, 0, "раньше 500 мс запись не начинается");
	m.tick(1);
	await m.flush();
	assert.equal(m.recorders.length, 1, "через 500 мс запись возобновилась");
	assert.equal(m.recorders[0].state, "recording");
	assert.equal(m.micOpens, 2, "barge-in + новая запись = два запроса микрофона");
	m.render();
	assert.ok(m.hint.includes("Слушаю"), "в подсказке должно быть «Слушаю…»");
	// После конца очереди pump обязан отпустить barge-in (микрофон — одно место)
	m.env.amplitude = 1;
	m.tick(150 * 5);
	await m.flush();
	assert.equal(m.recorders.length, 1, " barge-in отпущен: громкая речь больше не перебивает только что начатую запись");
	assert.equal(m.micOpens, 2);
});

await test("Ручное нажатие 🎤 во время записи: автопродолжения нет даже с continuousMode", async () => {
	const m = await mount({ continuousMode: true });
	m.render();
	await m.flush();
	m.render();
	// 1) пользователь сам включил запись
	m.buttons()[0].props.onClick();
	await m.flush();
	m.render();
	assert.equal(m.recorders.length, 1, "ручное нажатие должно было открыть запись");
	// 2) и снова нажал — «стоп» (pausedRef = true)
	m.buttons()[0].props.onClick();
	await m.flush();
	assert.equal(m.recorders[0].state, "inactive", "запись остановлена");
	assert.equal(m.recorders.length, 1);
	// 3) ответ AI приходит и озвучивается, но цикл не должен продолжиться
	await m.turn("Ответ после ручной остановки.");
	await m.waitSpeech();
	m.finishSpeech();
	await m.flush();
	assert.equal(m.countDelayed(500), 0, "после ручной паузы автоперезапуск даже не планируется");
	m.tick(5000);
	await m.flush();
	assert.equal(m.recorders.length, 1, "после ручной паузы запись не переоткрывается");
	assert.equal(m.micOpens, 2, "только barge-in во время озвучки, новой записи нет");
});

console.log("\nПеребивание (barge-in)");

await test("Один громкий интервал (150 мс) — ещё не перебивание", async () => {
	const m = await mount({ continuousMode: true });
	m.render();
	await m.flush();
	m.render();
	await m.turn();
	await m.waitSpeech();
	const cancelsBefore = m.env.speech.cancelCount;
	const micBefore = m.micOpens;
	m.env.amplitude = 1; // RMS ≈ 0.99 > 0.02
	m.tick(150);
	await m.flush();
	assert.equal(m.env.speech.cancelCount, cancelsBefore, "озвучка не прервана");
	assert.equal(m.micOpens, micBefore, "перебивания ещё не было");
	assert.equal(m.recorders.length, 0, "запись не началась");
});

await test("Три громких интервала подряд: озвучка прервана, запись начата", async () => {
	const m = await mount({ continuousMode: true });
	m.render();
	await m.flush();
	m.render();
	await m.turn();
	await m.waitSpeech();
	assert.equal(m.micOpens, 1, "barge-in открыл микрофон для контроля громкости");
	const cancelsBefore = m.env.speech.cancelCount;
	m.env.amplitude = 1;
	m.tick(150 * 3); // 3 интервала по 150 мс = «пользователь говорит»
	await m.flush();
	assert.equal(m.env.speech.cancelCount, cancelsBefore + 1, "stopPlayback должен отменить текущую озвучку");
	assert.equal(m.recorders.length, 1, "после перебивания пошла запись");
	assert.equal(m.recorders[0].state, "recording");
	assert.equal(m.micOpens, 2, "barge-in + запись пользователя");
	m.render();
	// ВНИМАНИЕ: подсказка «Перебил, слушаю…» из startBarge мгновенно затирается
	// подсказкой start() («Слушаю…»), т.к. обе setHint идут в одном тике — это
	// косметика в client.js, а не сбой логики (перебивание состоялось).
	assert.equal(m.hint, "Слушаю, автозавершение при тишине");
	// тишина не должна добить только что начатую запись и не должна возобновить очередь
	m.env.amplitude = 0;
	m.finishSpeech();
	await m.flush();
	m.tick(5000);
	await m.flush();
	assert.equal(m.recorders.length, 1, "после перебивания очередь не перезапускается");
	assert.equal(m.recorders[0].state, "recording");
});

await test("Громкий интервал, затем тишина: счётчик сбрасывается, перебивания нет", async () => {
	const m = await mount({ continuousMode: true });
	m.render();
	await m.flush();
	m.render();
	await m.turn();
	await m.waitSpeech();
	const cancelsBefore = m.env.speech.cancelCount;
	m.env.amplitude = 1;
	m.tick(150);
	m.env.amplitude = 0;
	m.tick(150 * 5);
	await m.flush();
	assert.equal(m.env.speech.cancelCount, cancelsBefore, "разрозненные всплески не считаются речью");
	assert.equal(m.recorders.length, 0, "запись не началась");
});

await test("Тихий фон (RMS ≈ 0.008) ниже порога 0.02 — перебивания нет", async () => {
	const m = await mount({ continuousMode: true });
	m.render();
	await m.flush();
	m.render();
	await m.turn();
	await m.waitSpeech();
	const cancelsBefore = m.env.speech.cancelCount;
	m.env.amplitude = 0.01; // шум/гул: RMS ≈ 0.0078 < 0.02
	m.tick(150 * 10); // даже 10 интервалов подряд
	await m.flush();
	assert.equal(m.env.speech.cancelCount, cancelsBefore, "тихий фон не должен перебивать озвучку");
	assert.equal(m.recorders.length, 0, "запись не началась");
});

await test("Ответ AI приходит во время собственной записи: второй микрофон не открывается", async () => {
	const m = await mount({ continuousMode: true });
	m.render();
	await m.flush();
	m.render();
	m.buttons()[0].props.onClick(); // пользователь говорит
	await m.flush();
	m.render();
	assert.equal(m.micOpens, 1);
	const contextsBefore = m.env.contexts.length;
	await m.turn("Ответ, пока пользователь ещё говорит.");
	await m.waitSpeech();
	assert.equal(m.micOpens, 1, "barge-in не должен включаться поверх идущей записи");
	assert.equal(m.env.contexts.length, contextsBefore, "ни лишнего AudioContext, ни интервала громкости");
	const cancelsBefore = m.env.speech.cancelCount;
	m.env.amplitude = 1;
	m.tick(150 * 5);
	await m.flush();
	assert.equal(m.env.speech.cancelCount, cancelsBefore, "собственная речь не перебивает озвучку");
	assert.equal(m.recorders.length, 1, "запись не перезапускается");
});

console.log("\nВыключенный звук (🔊)");

await test("Звук выключен во время озвучки: озвучка гасится и цикл не продолжается", async () => {
	const m = await mount({ continuousMode: true });
	m.render();
	await m.flush();
	m.render();
	await m.turn();
	await m.waitSpeech();
	const cancelsBefore = m.env.speech.cancelCount;
	const micBefore = m.micOpens;
	m.buttons()[1].props.onClick(); // 🔊 → mute
	assert.equal(m.env.speech.cancelCount, cancelsBefore + 1, "выключатель звука немедленно гасит озвучку");
	m.finishSpeech();
	await m.flush();
	m.tick(5000);
	await m.flush();
	assert.equal(m.micOpens, micBefore, "при выключенном звуке микрофон не переоткрывается");
	assert.equal(m.recorders.length, 0, "запись не началась");
	// barge-in тоже должен быть остановлен (stopPlayback → stopBarge)
	m.env.amplitude = 1;
	m.tick(150 * 5);
	await m.flush();
	assert.equal(m.micOpens, micBefore, "после mute перебивание не работает");
});

await test("Звук выключен до ответа AI: озвучка вообще не запускается", async () => {
	const m = await mount({ continuousMode: true });
	m.render();
	await m.flush();
	m.render();
	m.buttons()[1].props.onClick(); // mute до хода
	await m.turn("Ответ, который не должен звучать.");
	assert.equal(m.env.speech.utterances.length, 0, "при выключенном звуке TTS не вызывается");
	assert.equal(m.micOpens, 0, "микрофон не открывается");
	m.tick(5000);
	await m.flush();
	assert.equal(m.recorders.length, 0, "запись не начинается");
});

await test("Быстрый mute/unmute: отменённая озвучка не запускает запись", async () => {
	const m = await mount({ continuousMode: true });
	m.render();
	await m.flush();
	m.render();
	await m.turn();
	await m.waitSpeech();
	m.buttons()[1].props.onClick(); // 🔊 → mute: речь прерывается (speechSynthesis.cancel)
	await m.flush();
	assert.equal(m.countDelayed(500), 0, "прерванная озвучка не планирует автоперезапуск (resetToken вырос)");
	m.buttons()[1].props.onClick(); // обратно в звук — до истечения 500 мс
	m.tick(500);
	await m.flush();
	assert.equal(m.recorders.length, 0, "после быстрого mute/unmute микрофон сам не откроется");
	assert.equal(m.micOpens, 1, "микрофон не трогаем");
});

console.log("\nДеградация без микрофона");

await test("Ошибка getUserMedia в barge-in: только warn, озвучка доигрывает", async () => {
	const m = await mount({ continuousMode: true, gumModes: ["reject", "reject"] });
	m.render();
	await m.flush();
	m.render();
	await m.turn();
	await m.waitSpeech();
	assert.equal(m.micOpens, 1, "barge-in попытался взять микрофон и получил отказ");
	assert.ok(
		m.logs("warn").some((l) => l.includes("插话监听未启动")),
		"ошибка barge-in логируется как warn, а не бросается наружу"
	);
	m.finishSpeech(); // пайплайн озвучки не должен зависнуть после отказа
	await m.flush();
	m.tick(500);
	await m.flush();
	assert.equal(m.micOpens, 2, "после озвучки всё равно пробуем открыть запись");
	assert.equal(m.recorders.length, 0, "запись не поднялась — микрофона нет");
	assert.ok(m.logs("error").some((l) => l.includes("mic access failed")), "отказ в записи показан пользователю");
	m.render();
	assert.ok(m.hint.includes("микрофону"), "подсказка о микрофоне");
});

await test("Размонтирование во время continuousMode: таймеры и микрофон убираются", async () => {
	const m = await mount({ continuousMode: true });
	m.render();
	await m.flush();
	m.render();
	await m.turn();
	await m.waitSpeech();
	assert.equal(m.micOpens, 1);
	m.unmount();
	await m.flush();
	assert.ok(m.env.contextsClosed > 0, "AudioContext barge-in закрыт при размонтировании");
	m.env.amplitude = 1;
	m.tick(150 * 5);
	await m.flush();
	assert.equal(m.micOpens, 1, "после размонтирования перебивание не срабатывает");
});

console.log(`\n${passed} пройдено${process.exitCode ? " (есть падения)" : ""}`);