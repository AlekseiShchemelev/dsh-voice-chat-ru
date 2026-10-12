/**
 * Чтение каталога моделей с диска — без состояния менеджера.
 *
 * faster-whisper кладёт снапшоты в <download_root>/models--<org>--<repo>,
 * Piper — в <download_root>/piper/<voice>/<voice>.onnx(+.json). Здесь
 * описано, как эти каталоги читаются для status() и для списка удаления в UI.
 *
 * @module dsh-voice-chat/local/store
 */

import { readdir } from "node:fs/promises";
import path from "node:path";
import { dirSize, pathExists } from "./proc.js";

/**
 * Совпадает ли каталог снапшота faster-whisper с запрошенной моделью.
 * Раньше тут был `entry.name.includes(model)` — подстрока, из-за чего
 * "large" совпадал с "large-v3" и наоборот, а UI помечал неиспользуемую
 * модель как «используется сейчас». Теперь правило одно и то же для
 * modelsState() (готовность) и downloadedModels() (галочка в UI).
 */
export function whisperSnapshotMatches(dirName, model) {
	const want = String(model ?? "").toLowerCase();
	const name = String(dirName ?? "").toLowerCase();
	if (!want) return false;
	return name === `models--systran--faster-whisper-${want}`
		|| name.endsWith(`-${want}`)
		|| name.endsWith(`-${want}-int8`);
}

/**
 * Что реально скачано в <modelsDir> — поштучно, с размерами.
 * Пользователь может накачать несколько моделей (две whisper, три голоса Piper),
 * и по одной кнопке «удалить всё» их не убрать: нужен список, из которого
 * видно, сколько места занимает каждый пункт и что именно удаляется.
 */
export async function downloadedModels(modelsDir, model, voice) {
	const out = [];
	// Голоса Piper: <modelsDir>/piper/<voice>/<voice>.onnx + .onnx.json
	try {
		const voices = await readdir(path.join(modelsDir, "piper"), { withFileTypes: true });
		for (const entry of voices) {
			if (!entry.isDirectory()) continue;
			const dir = path.join(modelsDir, "piper", entry.name);
			const onnx = path.join(dir, `${entry.name}.onnx`);
			if (!(await pathExists(onnx))) continue;
			out.push({
				id: `piper/${entry.name}`,
				type: "piper",
				name: entry.name,
				dir,
				bytes: await dirSize(dir),
				inUse: entry.name === voice
			});
		}
	} catch { /* каталога нет — голоса не качались */ }
	// faster-whisper: <modelsDir>/models--<org>--faster-whisper-<size>
	try {
		const entries = await readdir(modelsDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory() || !entry.name.startsWith("models--")) continue;
			if (!entry.name.includes("whisper")) continue;
			const dir = path.join(modelsDir, entry.name);
			out.push({
				id: entry.name,
				type: "whisper",
				// models--Systran--faster-whisper-small → small
				name: entry.name.replace(/^models--.*?faster-whisper-?/, "") || entry.name,
				dir,
				bytes: await dirSize(dir),
				inUse: whisperSnapshotMatches(entry.name, model)
			});
		}
	} catch { /* каталога нет — модели не качались */ }
	out.sort((a, b) => b.bytes - a.bytes);
	return out;
}

/**
 * Лежат ли на диске ИМЕННО запрошенные цели (голос Piper и модель whisper).
 * Раньше подходил любой снапшот whisper, и UI показывал «модели готовы»
 * при скачанном small, пока пользователь просил medium — а запрос шёл
 * в medium и падал.
 */
export async function modelsState(modelsDir, model, voice) {
	const voiceOnnx = path.join(modelsDir, "piper", voice, `${voice}.onnx`);
	const voiceConfig = path.join(modelsDir, "piper", voice, `${voice}.onnx.json`);
	const piperReady = (await pathExists(voiceOnnx)) && (await pathExists(voiceConfig));
	const want = String(model).toLowerCase();
	let whisperReady = false;
	try {
		const entries = await readdir(modelsDir);
		whisperReady = entries.some((name) => name.startsWith("models--")
			&& name.includes("whisper")
			&& whisperSnapshotMatches(name, want));
	} catch { /* каталога нет — модель не качалась */ }
	return { piperReady, whisperReady, ready: piperReady && whisperReady };
}
