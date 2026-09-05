const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

export function trimPaneRowPadding(ansi: string): string {
	// Preserve trailing spaces painted by background or reverse SGR.
	const tail: number[] = [];
	const cut: number[] = [];
	let bg = false;
	let reverse = false;

	const endRow = (): void => {
		for (const at of tail) cut.push(at);
		tail.length = 0;
	};

	// Extended SGR colors consume their declared arity.
	const applySgr = (params: number[]): void => {
		if (params.length === 0) {
			bg = false;
			reverse = false;
			return;
		}
		for (let k = 0; k < params.length; k++) {
			const code = params[k];
			if (code === 0) {
				bg = false;
				reverse = false;
			} else if (code === 7) {
				reverse = true;
			} else if (code === 27) {
				reverse = false;
			} else if (code === 49) {
				bg = false;
			} else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
				bg = true;
			} else if (code === 38 || code === 48) {
				if (code === 48 && (params[k + 1] === 5 || params[k + 1] === 2)) bg = true;
				if (params[k + 1] === 5) k += 2;
				else if (params[k + 1] === 2) k += 4;
			}
		}
	};

	let i = 0;
	while (i < ansi.length) {
		const c = ansi[i];
		if (c === ESC && ansi[i + 1] === "[") {
			let j = i + 2;
			while (j < ansi.length && ansi[j] < "@") j++;
			// Empty SGR parameters are ignored.
			if (ansi[j] === "m") {
				applySgr(
					ansi
						.slice(i + 2, j)
						.split(";")
						.filter((p) => p !== "")
						.map(Number)
						.filter(Number.isInteger),
				);
			}
			i = j < ansi.length ? j + 1 : ansi.length;
			continue;
		}
		if (c === ESC && ansi[i + 1] === "]") {
			// OSC payload spaces are not pane padding.
			let j = i + 2;
			while (j < ansi.length) {
				if (ansi[j] === BEL) {
					j++;
					break;
				}
				if (ansi[j] === ESC && ansi[j + 1] === "\\") {
					j += 2;
					break;
				}
				j++;
			}
			i = j;
			continue;
		}
		if (c === ESC) {
			i++;
			continue;
		}
		if (c === "\n") {
			endRow();
			i++;
			continue;
		}
		if (c === " " && !bg && !reverse) tail.push(i);
		else tail.length = 0;
		i++;
	}
	endRow();

	if (cut.length === 0) return ansi;
	let out = "";
	let from = 0;
	for (const at of cut) {
		out += ansi.slice(from, at);
		from = at + 1;
	}
	return out + ansi.slice(from);
}
