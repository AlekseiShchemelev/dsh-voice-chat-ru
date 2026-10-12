/**
 * Процессы и файловые операции локального движка — без состояния менеджера.
 *
 * Запуск Python с таймаутом, молчаливая проверка интерпретатора, скачивание
 * с прогрессом, распаковка tar.gz. Всё здесь — чистые функции: менеджер
 * передаёт им пути и таймауты, состояние (child, кэши, журнал) остаётся
 * в lib/local-engine.js.
 *
 * @module dsh-voice-chat/local/proc
 */

import { spawn } from "node:child_process";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Минимальная поддерживаемая версия Python (см. py/requirements.txt). */
export const MIN_PYTHON = { major: 3, minor: 10 };

/** Гонка «событие vs таймаут»; таймер всегда снимается, чтобы не держать цикл событий. */
export function withDeadline(promise, ms, onTimeout) {
	let timer;
	const deadline = new Promise((resolve) => {
		timer = setTimeout(() => resolve(onTimeout), ms);
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

export async function pathExists(target) {
	try {
		await stat(target);
		return true;
	} catch {
		return false;
	}
}

/** Скачать URL на диск постранично (для прогресса); возвращает размер в байтах. */
export async function downloadFile(url, dest, onProgress) {
	const resp = await fetch(url);
	if (!resp.ok) throw new Error(`HTTP ${resp.status} при скачивании ${url}`);
	const total = Number(resp.headers.get("content-length")) || 0;
	const reader = resp.body.getReader();
	const chunks = [];
	let received = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		received += value.length;
		if (onProgress && total) onProgress(received, total);
	}
	const buf = Buffer.concat(chunks);
	await writeFile(dest, buf);
	return buf.length;
}

/** Распаковать tar.gz системным tar, срезая первый компонент (корень сборки). */
export async function extractTarGz(src, dest) {
	await mkdir(dest, { recursive: true });
	const proc = spawn("tar", ["-xzf", src, "-C", dest, "--strip-components=1"]);
	return new Promise((resolve, reject) => {
		proc.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`tar завершился с кодом ${code}`));
		});
		proc.on("error", reject);
	});
}

/**
 * Запустить команду и вернуть `{ stdout, stderr }`.
 * Таймаут убивает процесс (SIGKILL): иначе зависший pip держал бы установку.
 */
export async function run(cmd, args, opts = {}) {
	const { timeoutMs, ...spawnOpts } = opts;
	const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...spawnOpts });
	let stdout = "";
	let stderr = "";
	proc.stdout?.on("data", (d) => { stdout += d; });
	proc.stderr?.on("data", (d) => { stderr += d; });
	return new Promise((resolve, reject) => {
		let timer = null;
		const settle = (fn) => {
			if (timer) { clearTimeout(timer); timer = null; }
			fn();
		};
		if (timeoutMs) {
			timer = setTimeout(() => {
				try { proc.kill("SIGKILL"); } catch { /* уже мёртв */ }
				settle(() => reject(new Error(`${cmd} не завершился за ${timeoutMs} мс`)));
			}, timeoutMs);
		}
		proc.on("close", (code) => {
			if (code === 0) settle(() => resolve({ stdout, stderr }));
			else settle(() => reject(new Error(`${cmd} завершился с кодом ${code}: ${stderr.slice(-500)}`)));
		});
		// Слушатель 'error' обязателен: без него неудачный spawn роняет весь процесс Node
		proc.on("error", (err) => settle(() => reject(new Error(`${cmd}: ${err.message}`))));
	});
}

/** Молча проверяет, что интерпретатор запускается. Никогда не бросает и не качает ничего. */
export async function isWorkingPython(binPath, timeoutMs) {
	if (!binPath) return false;
	try {
		await run(binPath, ["--version"], { timeoutMs });
		return true;
	} catch {
		return false;
	}
}

/**
 * Версия интерпретатора в виде `{ major, minor }` или null, если определить не
 * удалось (тогда проверку пропускаем: не блокировать же установку из-за
 * нестандартного вывода).
 */
export async function pythonVersion(binPath, timeoutMs) {
	if (!binPath) return null;
	try {
		const { stdout, stderr } = await run(binPath, ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"], { timeoutMs });
		const m = /(\d+)\.(\d+)/.exec(`${stdout}${stderr}`);
		if (!m) return null;
		return { major: Number(m[1]), minor: Number(m[2]) };
	} catch {
		return null;
	}
}

/** Версия ниже минимальной? `null` (неизвестно) считаем подходящей. */
export function isTooOldPython(version) {
	if (!version) return false;
	return version.major < MIN_PYTHON.major
		|| (version.major === MIN_PYTHON.major && version.minor < MIN_PYTHON.minor);
}

/** Ошибка «некорректный ввод» (HTTP 400), чтобы маршруты отдавали правильный код. */
export function badRequest(message) {
	const err = new Error(message);
	err.status = 400;
	return err;
}

/** Рекурсивный размер каталога в байтах (модели весят сотни мегабайт — надо их видеть). */
export async function dirSize(dir) {
	let total = 0;
	let entries;
	try { entries = await readdir(dir, { withFileTypes: true }); }
	catch { return 0; }
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		try {
			if (entry.isDirectory()) total += await dirSize(full);
			else total += (await stat(full)).size;
		} catch { /* файл мог исчезнуть между readdir и stat */ }
	}
	return total;
}
