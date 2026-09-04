package com.atelier_nyaarium.switchboard

data class ScheduledSendPlan(
	val echo: Message,
	val opId: String,
	val text: String,
	val fileRefs: List<MessageFile>,
	val targetDomainId: String?,
)

fun composeScheduledSend(rec: ScheduledSend, at: Long): ScheduledSendPlan =
	ScheduledSendPlan(
		echo = Message(true, rec.text, at, files = rec.fileRefs, status = "pending", opId = rec.opId),
		opId = rec.opId,
		text = rec.text,
		fileRefs = rec.fileRefs,
		targetDomainId = rec.targetDomainId,
	)
