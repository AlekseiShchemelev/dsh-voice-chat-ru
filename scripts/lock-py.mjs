#!/usr/bin/env node
/**
 * Генерация py/requirements.lock из РЕАЛЬНО установленного окружения.
 *
 * ПОЧЕМУ ТАК. requirements.txt — это диапазоны («av>=10», «piper-tts>=1.2,<2»),
 * и с ними установка у пользователей непредсказуема: свежий PyAV или piper-tts
 * могут сломать совместимость, проверенную в py/server.py. Lock фиксирует
 * точные версии, на которых сборка проверена.
 *
 * Берётся не «что pip скачал бы сейчас», а «что стоит в venv плагина» — то
 * самое рабочее окружение, которым пользуется локальный движок. Поэтому
 * скрипт ищет интерпретатор в таком порядке:
 *   1. --python <path>           (ручное указание);
 *   2. DSH_VOICE_PYTHON          (как у плагина);
 *   3. venv плагина в dataDir    (~/.local/share/dsh-voice-chat/venv);
 *   4. python3                   (системный).
 *
 * Запуск: npm run lock:py [-- --python /путь/к/python3]
 * Результат: py/requirements.lock (коммитится в репозиторий).
 */

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { venvPythonPath } from "../lib/local-engine.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LOCK_FILE = path.join(ROOT, "py", "requirements.lock");

/** Пакеты, без которых lock бессмыслен: их нет в окружении — бери другой python. */
const REQUIRED = ["faster-whisper", "piper-tts", "av", "numpy"];

const args = process.argv.slice(2);
const explicit = (() => {
	const i = args.indexOf("--python");
	return i >= 0 ? args[i + 1] : null;
})();

function dataDir() {
	return process.env.DSH_VOICE_DATA_DIR || path.join(
		process.env.HOME || process.env.USERPROFILE || os.tmpdir(),
		".local", "share", "dsh-voice-chat"
	);
}

function candidates() {
	const list = [];
	if (explicit) list.push(explicit);
	if (process.env.DSH_VOICE_PYTHON) list.push(process.env.DSH_VOICE_PYTHON);
	list.push(venvPythonPath(path.join(dataDir(), "venv")));
	list.push("python3");
	return list;
}

async function isRunnable(bin) {
	try {
		await access(bin);
	}
	catch {
		// в PATH («python3») файла может не быть — проверяем запуском ниже
		if (bin.includes(path.sep)) return false;
	}
	return spawnSync(bin, ["--version"], { encoding: "utf8" }).status === 0;
}

let python = null;
for (const bin of candidates()) {
	if (await isRunnable(bin)) { python = bin; break; }
}
if (!python) {
	console.error("lock: не найден рабочий Python. Установите локальный движок "
		+ "или передайте путь: npm run lock:py -- --python /путь/к/python3");
	process.exit(1);
}

const freeze = spawnSync(python, ["-m", "pip", "freeze", "--disable-pip-version-check"], {
	encoding: "utf8",
	maxBuffer: 10 * 1024 * 1024
});
if (freeze.status !== 0) {
	console.error(`lock: pip freeze не удался (${python}): ${(freeze.stderr || "").trim()}`);
	process.exit(1);
}

const lines = freeze.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
// freeze пишет «имя==версия» (и «имя @ url» для editable) — имя до первого «==»
const names = lines.map((l) => l.split("==")[0].split(" @ ")[0].trim().toLowerCase().replaceAll("_", "-"));
const missing = REQUIRED.filter((r) => !names.includes(r));
if (missing.length) {
	console.error(`lock: в окружении (${python}) нет нужных пакетов: ${missing.join(", ")}. `
		+ "Похоже, это не venv плагина — укажите свой интерпретатор: npm run lock:py -- --python <путь>");
	process.exit(1);
}

const header = [
	"# Точные версии Python-зависимостей, проверенные с py/server.py.",
	"# Сгенерировано из рабочего окружения (npm run lock:py) — НЕ редактировать руками.",
	"# Для восстановления: python -m pip install -r py/requirements.lock",
	`# Источник: ${python}, ${new Date().toISOString().slice(0, 10)}`,
	""
].join("\n");

writeFileSync(LOCK_FILE, header + lines.sort().join("\n") + "\n", "utf8");
console.log(`lock: ${lines.length} пакетов записано в ${path.relative(ROOT, LOCK_FILE)} (интерпретатор: ${python})`);
