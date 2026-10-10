/**
 * Разговорный пересказ ответа через LLM-сервис самого harness.
 *
 * Отдельный модуль, потому что пересказ — единственное место, где плагин ходит
 * в чужой сервис (llm) и где важно не превратить сжатие в расширение текста.
 *
 * @module dsh-voice-chat/rewrite
 */

/** Промпт пересказа: голосом самого AI-ассистента, короткий доклад; только сжатие, никакого расширения. */
export const SPEAK_SYSTEM_PROMPT = "Ты — тот самый AI-ассистент, который только что ответил пользователю. " +
	"Теперь сделай краткий устный отчёт по своему ответу: коротко, по делу, сначала вывод, затем ключевые моменты; " +
	"разговорный стиль, естественно, без лишних слов и вступлений; " +
	"без кода, таблиц, ссылок и markdown-разметки, при необходимости одной фразой обсуть суть; " +
	"только сжатие и обобщение оригинала, запрещено добавлять новое и отвлекаться; " +
	"результат должен быть короче или равен оригиналу, никогда не длиннее; " +
	"если оригинал короткий (например «Понял», «Хорошо, сделаю»), просто повтори его без изменений; " +
	"выдавай только текст отчёта, не более 150 слов. " +
	"Отвечай на том же языке, что и пользователь.";

/**
 * Разговорный пересказ через LLM-сервис самого harness (та же модель и ключ, что у агента).
 * При ошибке бросает исключение, и вызывающая сторона откатывается к чтению оригинала.
 * @param httpCtx - контекст с внедрёнными сервисами webServer и llm.
 * @param text - исходный ответ AI для пересказа.
 * @param provider - id провайдера harness (например, "deepseek-official"), который клиент передаёт из текущего диалога.
 * @param model - имя модели harness (deepseek-v4-flash / deepseek-v4-pro / своя ...).
 */
export async function rewriteWithHarness(httpCtx, text, provider, model) {
	const llm = httpCtx.llm;
	if (llm === undefined) throw new Error("LLM-сервис harness недоступен");
	/** Один вызов пересказа: запускает поток с заданными параметрами и сводит его к тексту; ошибки пробрасываются вверх. */
	const runOnce = async (extra) => {
		const stream = llm.stream({
			provider,
			model,
			system: SPEAK_SYSTEM_PROMPT,
			messages: [
				{ role: "user", content: [{ type: "text", text: text.slice(0, 6000) }] }
			],
			maxTokens: 2000,
			...extra
		});
		let out = "";
		for await (const chunk of stream) {
			if (chunk.type === "text-delta") {
				out += chunk.text;
			} else if (chunk.type === "finish") {
				const reason = chunk.reason;
				// Блок завершения с ошибкой/прерыванием несёт настоящую причину сбоя, его обязательно нужно бросить (иначе это посчитают «успехом, но пусто» и молча прочитают оригинал)
				if (reason.kind === "error" || reason.kind === "aborted") {
					const failure = reason.failure;
					let detail = "";
					if (failure) {
						detail = typeof failure === "string" ? failure
							: (failure.message ?? failure.code ?? JSON.stringify(failure));
					}
					throw new Error(`Ошибка пересказа LLM harness (${reason.kind}): ${String(detail)}`.trim());
				}
				if (reason.kind !== "stop" && reason.kind !== "tool-calls" && reason.kind !== "max-tokens") {
					throw new Error("LLM harness неожиданно завершился: " + JSON.stringify(reason));
				}
			}
		}
		if (out.trim() === "") throw new Error("LLM harness вернул пустой результат пересказа");
		return out.trim();
	};
	// Сначала пробуем отключить размышление (официальные рассуждающие модели deepseek: отвечают
	// сразу, без размышления — быстрее и стабильнее); но модели вроде pi-ai, работающие через
	// совместимый AI-прокси, параметр reasoningEffort не поддерживают, при ошибке повторяем без него.
	try {
		return await runOnce({ reasoningEffort: "off" });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!/reasoning effort/i.test(message)) throw error;
		console.warn(`[dsh-voice-chat] rewrite: ${provider}/${model} не поддерживает reasoningEffort=off, повторяем без этого параметра`);
		return await runOnce({});
	}
}
