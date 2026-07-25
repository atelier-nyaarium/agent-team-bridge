export namespace Shop {
	export class Cart {
		private items: string[] = [];

		add(item: string, qty: number): void {
			this.items.push(item);
			this.count += 1;
			reset();
			this.count += 1;
		}
	}
}
