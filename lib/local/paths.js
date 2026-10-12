/**
 * Пути, константы и справочники локального Python-движка.
 *
 * Здесь только то, что не зависит от состояния менеджера: где лежат каталоги
 * portable Python / venv / моделей, какие таймауты и дефолты, куда качается
 * сборка python-build-standalone. Менеджер (createLocalEngineManager) берёт
 * отсюда всё, кроме жизненного цикла процессов и файловой работы.
 *
 * @module dsh-voice-chat/local/paths
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// lib/local/paths.js → py/ на два уровня выше
const LIB_DIR = path.join(HERE, "..");
export const PY_DIR = path.join(LIB_DIR, "..", "py");
export const SERVER_PY = path.join(PY_DIR, "server.py");
export const DOWNLOAD_MODELS_PY = path.join(PY_DIR, "download_models.py");
export const REQUIREMENTS_TXT = path.join(PY_DIR, "requirements.txt");

export const LOG = "[dsh-voice-chat] local-engine:";

export const DEFAULT_PORT = 8765;
export const DEFAULT_START_TIMEOUT_MS = 30_000;
export const DEFAULT_HEALTH_POLL_MS = 250;
export const DEFAULT_HEALTH_TIMEOUT_MS = 2_000;
export const DEFAULT_STOP_TIMEOUT_MS = 2_000;
export const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
/** Импорт ctranslate2/onnxruntime может идти несколько секунд — отдельный таймаут. */
export const DEFAULT_DEPS_PROBE_TIMEOUT_MS = 90_000;
/** Таймаут фонового прогорева и минимальный интервал между прогоревами. */
export const DEFAULT_WARM_TIMEOUT_MS = 180_000;
export const DEFAULT_WARM_INTERVAL_MS = 60_000;
export const DEFAULT_WHISPER_MODEL = "small";
export const DEFAULT_PIPER_VOICE = "ru_RU-irina-medium";

/**
 * Сколько живёт кэш готовности окружения.
 *
 * Раньше каждый /stt и /speak вызывали status(), а он поднимал до четырёх
 * процессов Python (`--version`), пробовал импорт faster_whisper/piper и
 * рекурсивно обходил каталог моделей. На холодном старте это десятки секунд
 * ожидания перед первым же распознаванием, а панель настроек, опрашивающая
 * /local/status раз в 2 с, умножала это ещё. Здесь достаточно короткого окна:
 * интерфейс держит в нём истину, а не переживает установку новых пакетов.
 */
export const READY_CACHE_MS = 2_000;
/** Окно повторного использования ответа status(). Панель опрашивает раз в 2 с. */
export const STATUS_CACHE_MS = 1_000;

export const PYTHON_VERSION = "3.12.15";
export const PYTHON_TAG = "20261003";
export const PYTHON_URL = `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_TAG}/cpython-${PYTHON_VERSION}+${PYTHON_TAG}-{platform}-install_only_stripped.tar.gz`;

/** Каталог данных плагина: python/venv/models/logs живут внутри. */
export function getDataDir() {
	return process.env.DSH_VOICE_DATA_DIR || path.join(
		process.env.HOME || process.env.USERPROFILE || "/tmp",
		".local", "share", "dsh-voice-chat"
	);
}

/** Тег triple для python-build-standalone; null — платформа не поддерживается. */
export function getPlatform() {
	const { platform, arch } = process;
	if (platform === "linux" && arch === "x64") return "x86_64-unknown-linux-gnu";
	if (platform === "linux" && arch === "arm64") return "aarch64-unknown-linux-gnu";
	if (platform === "darwin" && arch === "x64") return "x86_64-apple-darwin";
	if (platform === "darwin" && arch === "arm64") return "aarch64-apple-darwin";
	if (platform === "win32" && arch === "x64") return "x86_64-pc-windows-msvc";
	if (platform === "win32" && arch === "arm64") return "aarch64-pc-windows-msvc";
	return null;
}

/** Интерпретатор внутри venv. На Windows это Scripts/python.exe, а НЕ bin/. */
export function venvPythonPath(venvDir) {
	return process.platform === "win32"
		? path.join(venvDir, "Scripts", "python.exe")
		: path.join(venvDir, "bin", "python3");
}

/** Интерпретатор portable Python: install_only сборки кладут его в корень на Windows. */
export function portablePythonPath(pythonDir) {
	return process.platform === "win32"
		? path.join(pythonDir, "python.exe")
		: path.join(pythonDir, "bin", "python3");
}
