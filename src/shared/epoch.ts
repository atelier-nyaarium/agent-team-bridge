export function mintEpoch(): number {
	return 1 + Math.floor(Math.random() * 0x7ffffffe);
}
