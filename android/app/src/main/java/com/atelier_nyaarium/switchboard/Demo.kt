package com.atelier_nyaarium.switchboard

/**
 * Debug-only demo session. It renders through the real Thread pipeline but never
 * touches the repository's persisted store, so it cannot pollute or resurface in
 * real transcripts. Gated everywhere behind BuildConfig.DEBUG; release builds
 * never reference it. The fixture exercises the full markdown matrix so the render
 * laps have one canonical thing to verify against.
 */
const val DEMO_TEAM = "demo"

private const val IMG_A =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAHgAAABQCAIAAABd+SbeAAAAqElEQVR4nO3QAQkAIADAMHOayZzmsIXCHTzA2Zhr60Lj+cEngQbdCjToVqBBtwINuhVo0K1Ag24FGnQr0KBbgQbdCjToVqBBtwINuhVo0K1Ag24FGnQr0KBbgQbdCjToVqBBtwINuhVo0K1Ag24FGnQr0KBbgQbdCjToVqBBtwINuhVo0K1Ag24FGnQr0KBbgQbdCjToVqBBtwINuhVo0K1Ag24FGnSrA37WZe60tIgSAAAAAElFTkSuQmCC"
private const val IMG_B =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAHgAAABQCAIAAABd+SbeAAAAqElEQVR4nO3QAQkAIADAMHMazIjmsIXCHTzA2dhr6kLj+cEngQbdCjToVqBBtwINuhVo0K1Ag24FGnQr0KBbgQbdCjToVqBBtwINuhVo0K1Ag24FGnQr0KBbgQbdCjToVqBBtwINuhVo0K1Ag24FGnQr0KBbgQbdCjToVqBBtwINuhVo0K1Ag24FGnQr0KBbgQbdCjToVqBBtwINuhVo0K1Ag24FGnSrA7To3P06gIvgAAAAAElFTkSuQmCC"
private const val IMG_C =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAHgAAABQCAIAAABd+SbeAAAAp0lEQVR4nO3QAQkAIBDAQGN/RGPZQmEeLMC4NXt0ofX84JNAg24FGnQr0KBbgQbdCjToVqBBtwINuhVo0K1Ag24FGnQr0KBbgQbdCjToVqBBtwINuhVo0K1Ag24FGnQr0KBbgQbdCjToVqBBtwINuhVo0K1Ag24FGnQr0KBbgQbdCjToVqBBtwINuhVo0K1Ag24FGnQr0KBbgQbdCjToVqBBtwINutUBoqx3wSzpDBEAAAAASUVORK5CYII="

private val DEMO_AT = 1_700_000_000_000L

private val richBody = """
# Build Report

A run through the **markdown matrix**: _italic_, **bold**, ~~strikethrough~~, and a
[link](https://example.com).

## Lists

- top level
  - nested item
  - nested item with `inline code`
1. first
2. second

> A blockquote, for the asides.

## Table

| step  | result | notes              |
|-------|--------|--------------------|
| lint  | pass   | biome + tsc        |
| test  | pass   | 142 cases          |
| build | pass   | apk 8.4 MB         |

## Code

```kotlin
fun greet(name: String): String {
	return "hi ${'$'}name"
}
```

```typescript
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
```

```bash
./gradlew :app:assembleDebug && adb install -r app-debug.apk
```

```json
{ "ok": true, "teams": 3, "pending": 0 }
```

```diff
- val old = legacyRender(msg)
+ val new = webViewRender(msg)
```
""".trimIndent()

private val flowchartBody = """
A flowchart:

```mermaid
flowchart LR
  A[lint] --> B[test]
  B --> C{pass?}
  C -->|yes| D[ship]
  C -->|no| E[fix]
  E --> A
```
""".trimIndent()

private val sequenceBody = """
A sequence diagram:

```mermaid
sequenceDiagram
  participant Phone
  participant Arbiter
  participant Agent
  Phone->>Arbiter: send
  Arbiter->>Agent: channel_push
  Agent-->>Arbiter: reply
  Arbiter-->>Phone: poll
```
""".trimIndent()

private val longBody = (1..14).joinToString("\n\n") {
	"Paragraph $it of a long plain-text message, here to check that ordinary prose wraps " +
		"and flows without code or tables getting in the way of readability on a narrow screen."
}

private val hugeCodeBody = buildString {
	append("A large code block, for virtualization sanity:\n\n```json\n")
	for (i in 1..120) append("""{ "id": $i, "name": "row-$i", "active": ${i % 2 == 0} },""").append("\n")
	append("```\n")
}

/** Built fresh each call; never stored. */
fun demoMessages(): List<Message> = listOf(
	Message(true, "Run the demo matrix please", DEMO_AT, 0),
	Message(false, richBody, DEMO_AT + 1000, 1),
	Message(false, flowchartBody, DEMO_AT + 2000, 2),
	Message(false, sequenceBody, DEMO_AT + 3000, 3),
	Message(
		false,
		"Image gallery:",
		DEMO_AT + 4000,
		4,
		listOf(
			MessageFile("blue.png", "image/png", IMG_A),
			MessageFile("orange.png", "image/png", IMG_B),
			MessageFile("green.png", "image/png", IMG_C),
		),
	),
	Message(
		false,
		"Attached files:",
		DEMO_AT + 5000,
		5,
		listOf(
			MessageFile("build.log", "text/plain"),
			MessageFile("trace.json", "application/json"),
			MessageFile("heap.hprof", "application/octet-stream"),
		),
	),
	Message(true, longBody, DEMO_AT + 6000, 6),
	Message(false, hugeCodeBody, DEMO_AT + 7000, 7),
	Message(false, "Waking demo... first boot can take a minute or two.", DEMO_AT + 8000, 8, status = "waking"),
	Message(true, "This send failed on purpose, to demo the retry badge.", DEMO_AT + 9000, 9, status = "error"),
)
