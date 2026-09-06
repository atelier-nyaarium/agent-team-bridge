// What a grant covers: the shape of every command a line names, wrappers peeled.

import {
	type ArithmeticExpression,
	type Command,
	type Node,
	parse,
	type Redirect,
	type Statement,
	type TestExpression,
	type Word,
	type WordPart,
} from "unbash";
import { VAULT_SHAPES_MAX } from "../../shared/schemasVault.js";

interface Wrapper {
	/** Options taking the next word. */
	valued: ReadonlySet<string>;
	/** Options taking none. An option in neither set stops the peel. */
	flags: ReadonlySet<string>;
	/** Modes running no program. */
	stops: ReadonlySet<string>;
	/** Its own words before the program, such as a duration. */
	leading?: number;
}

const none: ReadonlySet<string> = new Set();
const version: ReadonlySet<string> = new Set(["--help", "--version"]);
const versionShort: ReadonlySet<string> = new Set(["-h", "--help", "-V", "--version"]);

/** Programs that run the next program here. One running a string or a remote program is not one. */
const WRAPPERS: Record<string, Wrapper> = {
	sudo: {
		valued: new Set([
			"-C",
			"--close-from",
			"-D",
			"--chdir",
			"-g",
			"--group",
			"-h",
			"--host",
			"-p",
			"--prompt",
			"-R",
			"--chroot",
			"-r",
			"--role",
			"-T",
			"--command-timeout",
			"-t",
			"--type",
			"-U",
			"--other-user",
			"-u",
			"--user",
		]),
		flags: new Set([
			"-A",
			"--askpass",
			"-B",
			"--bell",
			"-b",
			"--background",
			"-E",
			"--preserve-env",
			"-H",
			"--set-home",
			"-i",
			"--login",
			"-k",
			"--reset-timestamp",
			"-n",
			"--non-interactive",
			"-P",
			"--preserve-groups",
			"-S",
			"--stdin",
			"-s",
			"--shell",
		]),
		stops: new Set([
			"-e",
			"--edit",
			"-l",
			"--list",
			"-v",
			"--validate",
			"-K",
			"--remove-timestamp",
			"-V",
			"--version",
			"--help",
		]),
	},
	doas: { valued: new Set(["-a", "-C", "-u"]), flags: new Set(["-n", "-s"]), stops: new Set(["-L"]) },
	pkexec: { valued: new Set(["--user"]), flags: new Set(["--disable-internal-agent", "--keep-cwd"]), stops: version },
	env: {
		valued: new Set(["-u", "--unset", "-C", "--chdir"]),
		// A signal list is attached or absent.
		flags: new Set([
			"-i",
			"--ignore-environment",
			"-0",
			"--null",
			"-v",
			"--debug",
			"--block-signal",
			"--default-signal",
			"--ignore-signal",
		]),
		// A split string is a line of its own.
		stops: new Set(["-S", "--split-string", "--list-signal-handling", "--help", "--version"]),
	},
	// A bare adjustment is `nice -5`.
	nice: {
		valued: new Set(["-n", "--adjustment"]),
		flags: new Set("0123456789".split("").map((d) => `-${d}`)),
		stops: version,
	},
	nohup: { valued: none, flags: none, stops: version },
	time: {
		valued: new Set(["-f", "--format", "-o", "--output"]),
		flags: new Set(["-a", "--append", "-p", "--portability", "-q", "--quiet", "-v", "--verbose"]),
		stops: version,
	},
	timeout: {
		valued: new Set(["-k", "--kill-after", "-s", "--signal"]),
		flags: new Set(["--foreground", "--preserve-status", "-v", "--verbose"]),
		stops: version,
		leading: 1,
	},
	chroot: {
		valued: new Set(["--groups", "--userspec"]),
		flags: new Set(["--skip-chdir"]),
		stops: version,
		leading: 1,
	},
	setsid: { valued: none, flags: new Set(["-c", "--ctty", "-f", "--fork", "-w", "--wait"]), stops: versionShort },
	stdbuf: { valued: new Set(["-i", "--input", "-o", "--output", "-e", "--error"]), flags: none, stops: version },
	ionice: {
		valued: new Set(["-c", "--class", "-n", "--classdata"]),
		flags: new Set(["-t", "--ignore"]),
		stops: new Set(["-p", "--pid", "-P", "--pgid", "-u", "--uid", "-h", "--help", "-V", "--version"]),
	},
	taskset: {
		valued: none,
		flags: new Set(["-a", "--all-tasks", "-c", "--cpu-list"]),
		stops: new Set(["-p", "--pid", "-h", "--help", "-V", "--version"]),
		leading: 1,
	},
	chrt: {
		valued: new Set(["-T", "--sched-runtime", "-P", "--sched-period", "-D", "--sched-deadline"]),
		flags: new Set([
			"-a",
			"--all-tasks",
			"-b",
			"--batch",
			"-d",
			"--deadline",
			"-f",
			"--fifo",
			"-i",
			"--idle",
			"-o",
			"--other",
			"-r",
			"--rr",
			"-R",
			"--reset-on-fork",
			"-v",
			"--verbose",
		]),
		stops: new Set(["-p", "--pid", "-m", "--max", "-h", "--help", "-V", "--version"]),
		leading: 1,
	},
	flock: {
		valued: new Set(["-w", "--timeout", "-E", "--conflict-exit-code"]),
		flags: new Set([
			"-s",
			"--shared",
			"-x",
			"--exclusive",
			"-n",
			"--nonblock",
			"-o",
			"--close",
			"-F",
			"--no-fork",
			"--verbose",
		]),
		stops: new Set(["-c", "--command", "-u", "--unlock", "-h", "--help", "-V", "--version"]),
		leading: 1,
	},
	xargs: {
		valued: new Set([
			"-a",
			"--arg-file",
			"-d",
			"--delimiter",
			"-E",
			"-I",
			"-L",
			"--max-lines",
			"-n",
			"--max-args",
			"-P",
			"--max-procs",
			"-s",
			"--max-chars",
			"--process-slot-var",
		]),
		flags: new Set([
			"-0",
			"--null",
			"-e",
			"--eof",
			"-i",
			"--replace",
			"-l",
			"-o",
			"--open-tty",
			"-p",
			"--interactive",
			"-r",
			"--no-run-if-empty",
			"-t",
			"--verbose",
			"-x",
			"--exit",
		]),
		stops: new Set(["--show-limits", "--help", "--version"]),
	},
	watch: {
		valued: new Set(["-n", "--interval", "-q", "--equexit"]),
		flags: new Set([
			"-b",
			"--beep",
			"-c",
			"--color",
			"-C",
			"--no-color",
			"-d",
			"--differences",
			"-e",
			"--errexit",
			"-g",
			"--chgexit",
			"-p",
			"--precise",
			"-r",
			"--no-rerun",
			"-t",
			"--no-title",
			"-w",
			"--no-wrap",
			"-x",
			"--exec",
		]),
		stops: new Set(["-h", "--help", "-v", "--version"]),
	},
	busybox: { valued: none, flags: none, stops: new Set(["--help", "--list", "--list-full", "--install"]) },
	command: { valued: none, flags: new Set(["-p"]), stops: new Set(["-v", "-V"]) },
	exec: { valued: new Set(["-a"]), flags: new Set(["-c", "-l"]), stops: none },
};

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** A trailing slash keeps the whole spelling. */
function basenameOf(program: string): string {
	return program.slice(program.lastIndexOf("/") + 1) || program;
}

function isStatic(part: WordPart): boolean {
	switch (part.type) {
		case "Literal":
		case "SingleQuoted":
		case "AnsiCQuoted":
			return true;
		case "DoubleQuoted":
		case "LocaleString":
			return part.parts.every((child) => child.type === "Literal");
		default:
			return false;
	}
}

/** The word dequoted, or its spelling when it expands. */
function spelled(word: Word): string {
	return word.parts === undefined || word.parts.every(isStatic) ? word.value : word.text;
}

/** An unknown option is a stop, so an unlisted one never peels onto its value. */
function optionKind(wrapper: Wrapper, word: string): "stop" | "valued" | "flag" | "word" {
	if (word === "-" || !word.startsWith("-")) return "word";
	if (word === "--") return "flag";
	if (word.startsWith("--")) {
		const equals = word.indexOf("=");
		const name = equals === -1 ? word : word.slice(0, equals);
		if (wrapper.stops.has(name)) return "stop";
		if (!wrapper.valued.has(name) && !wrapper.flags.has(name)) return "stop";
		return equals === -1 && wrapper.valued.has(name) ? "valued" : "flag";
	}
	// `-pa` is `-p -a`, and a valued letter takes the bundle's tail.
	const letters = word.slice(1);
	for (let at = 0; at < letters.length; at++) {
		const letter = `-${letters[at]}`;
		if (wrapper.stops.has(letter)) return "stop";
		if (wrapper.valued.has(letter)) return at === letters.length - 1 ? "valued" : "flag";
		if (!wrapper.flags.has(letter)) return "stop";
	}
	return "flag";
}

/** The wrapped program's index in `rest`, or undefined when the wrapper runs none. */
function wrapped(wrapper: Wrapper, program: string, rest: string[]): number | undefined {
	let leading = wrapper.leading ?? 0;
	for (let index = 0; index < rest.length; index++) {
		const word = rest[index] as string;
		const kind = optionKind(wrapper, word);
		if (kind === "stop") return undefined;
		if (kind === "valued") index++;
		else if (kind === "flag" || (program.endsWith("env") && ASSIGNMENT_RE.test(word))) continue;
		else if (leading > 0) leading--;
		else return index;
	}
	return undefined;
}

/**
 * The one shape rule, which the display shape and every member of the set both take: the program's
 * basename and its first argument, or every argument once a flag leads, since a flag's value can
 * hide the target.
 */
export function shapeFrom(words: string[]): string {
	const program = words[0];
	if (program === undefined) return "";
	const name = basenameOf(program);
	const rest = words.slice(1);
	const first = rest[0];
	if (first === undefined) return name;
	return first.startsWith("-") ? [name, ...rest].join(" ") : `${name} ${first}`;
}

/** One command's shape, wrappers peeled. A `time` pipeline's command loses a leading `--`. */
function shapeOf(words: string[], timed: boolean): string | undefined {
	let program = words[0];
	let rest = words.slice(1);
	if (timed && program === "--") {
		program = rest[0];
		rest = rest.slice(1);
	}
	while (program !== undefined) {
		const wrapper = WRAPPERS[basenameOf(program)];
		const index = wrapper === undefined ? undefined : wrapped(wrapper, program, rest);
		if (index === undefined) break;
		program = rest[index];
		rest = rest.slice(index + 1);
	}
	return program === undefined ? undefined : shapeFrom([program, ...rest]);
}

/** Each switch is exhaustive, so a new unbash node fails to typecheck. */
class Collector {
	readonly shapes = new Set<string>();

	statements(statements: Statement[]): void {
		for (const statement of statements) this.node(statement);
	}

	node(node: Node | undefined, timed = false): void {
		if (node === undefined) return;
		switch (node.type) {
			case "Statement":
				this.node(node.command);
				this.redirects(node.redirects);
				return;
			case "Command":
				this.command(node, timed);
				return;
			case "Pipeline":
				for (const [index, command] of node.commands.entries())
					this.node(command, node.time === true && index === 0);
				return;
			case "AndOr":
				for (const command of node.commands) this.node(command);
				return;
			case "CompoundList":
				this.statements(node.commands);
				return;
			case "Subshell":
			case "BraceGroup":
				this.node(node.body);
				return;
			case "While":
				this.node(node.clause);
				this.node(node.body);
				return;
			case "If":
				this.node(node.clause);
				this.node(node.then);
				this.node(node.else);
				return;
			case "For":
			case "Select":
				this.words(node.wordlist);
				this.node(node.body);
				return;
			case "Case":
				this.word(node.word);
				for (const item of node.items) {
					this.words(item.pattern);
					this.node(item.body);
				}
				return;
			case "Function":
			case "Coproc":
				this.node(node.body);
				this.redirects(node.redirects);
				return;
			case "ArithmeticFor":
				this.arithmetic(node.initialize);
				this.arithmetic(node.test);
				this.arithmetic(node.update);
				this.node(node.body);
				return;
			case "TestCommand":
				this.test(node.expression);
				return;
			case "ArithmeticCommand":
				this.arithmetic(node.expression);
				return;
			default:
				unreachable(node);
		}
	}

	private command(node: Command, timed: boolean): void {
		for (const prefix of node.prefix) {
			this.word(prefix.value);
			this.words(prefix.array ?? []);
		}
		this.redirects(node.redirects);
		if (node.name === undefined) return;
		const words = [node.name, ...node.suffix];
		this.words(words);
		const shape = shapeOf(words.map(spelled), timed);
		// An empty program word names none.
		if (shape) this.shapes.add(shape);
	}

	private redirects(redirects: Redirect[]): void {
		for (const redirect of redirects) {
			this.word(redirect.target);
			this.word(redirect.body);
		}
	}

	private words(words: Word[]): void {
		for (const word of words) this.word(word);
	}

	private word(word: Word | undefined): void {
		this.parts(word?.parts);
	}

	private parts(parts: WordPart[] | undefined): void {
		for (const part of parts ?? []) this.part(part);
	}

	private part(part: WordPart): void {
		switch (part.type) {
			case "Literal":
			case "SingleQuoted":
			case "AnsiCQuoted":
			case "SimpleExpansion":
				return;
			case "DoubleQuoted":
			case "LocaleString":
			case "ExtendedGlob":
			case "BraceExpansion":
				this.parts(part.parts);
				return;
			case "CommandExpansion":
			case "ProcessSubstitution":
				this.statements(part.script?.commands ?? []);
				return;
			case "ArithmeticExpansion":
				this.arithmetic(part.expression);
				return;
			case "ParameterExpansion":
				this.parts(part.indexParts);
				this.word(part.operand);
				this.word(part.slice?.offset);
				this.word(part.slice?.length);
				this.word(part.replace?.pattern);
				this.word(part.replace?.replacement);
				return;
			default:
				unreachable(part);
		}
	}

	private arithmetic(expression: ArithmeticExpression | undefined): void {
		if (expression === undefined) return;
		switch (expression.type) {
			case "ArithmeticBinary":
				this.arithmetic(expression.left);
				this.arithmetic(expression.right);
				return;
			case "ArithmeticUnary":
				this.arithmetic(expression.operand);
				return;
			case "ArithmeticTernary":
				this.arithmetic(expression.test);
				this.arithmetic(expression.consequent);
				this.arithmetic(expression.alternate);
				return;
			case "ArithmeticGroup":
				this.arithmetic(expression.expression);
				return;
			case "ArithmeticWord":
				this.parts(expression.parts);
				return;
			case "ArithmeticCommandExpansion":
				this.statements(expression.script?.commands ?? []);
				return;
			default:
				unreachable(expression);
		}
	}

	private test(expression: TestExpression): void {
		switch (expression.type) {
			case "TestUnary":
				this.word(expression.operand);
				return;
			case "TestBinary":
				this.word(expression.left);
				this.word(expression.right);
				return;
			case "TestLogical":
				this.test(expression.left);
				this.test(expression.right);
				return;
			case "TestNot":
				this.test(expression.operand);
				return;
			case "TestGroup":
				this.test(expression.expression);
				return;
			default:
				unreachable(expression);
		}
	}
}

function unreachable(node: never): never {
	throw new Error(`unbash node not walked: ${String((node as { type?: string }).type)}`);
}

/**
 * Every program a command line names, each as its shape, sorted. A parse failure, or a program
 * count outside one to `VAULT_SHAPES_MAX`, makes the line its own shape, covering nothing else.
 */
export function operationSet(operation: string): string[] {
	const text = operation.trim();
	try {
		const script = parse(text);
		if ((script.errors?.length ?? 0) > 0) return [text];
		const collector = new Collector();
		collector.statements(script.commands);
		if (collector.shapes.size === 0 || collector.shapes.size > VAULT_SHAPES_MAX) return [text];
		return [...collector.shapes].sort();
	} catch {
		return [text];
	}
}

/** Whether every shape of a request is among a grant's. */
export function coveredBy(requested: readonly string[], granted: readonly string[]): boolean {
	return requested.every((shape) => granted.includes(shape));
}
