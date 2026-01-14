export interface RouletteItem {
    id: string;
    text: string;
    weight: number;
    color: string;
}

export class RouletteManager {
    private items: RouletteItem[] = [];
    private isSpinning: boolean = false;
    private winner: RouletteItem | null = null;
    private onStateChangeCallback: (type: string, payload: any) => void = () => {};

    constructor(private bot: any, initialData?: any[]) {
        this.items = initialData || [];
    }

    public setOnStateChangeListener(callback: (type: string, payload: any) => void) {
        this.onStateChangeCallback = callback;
    }

    private notify() {
        this.onStateChangeCallback('rouletteStateUpdate', this.getState());
        this.bot.saveAll();
    }

    public createRoulette(items: RouletteItem[]) {
        this.items = items;
        this.winner = null;
        this.notify();
    }

    public spin(): RouletteItem | null {
        if (this.items.length === 0 || this.isSpinning) return null;
        
        this.isSpinning = true;
        this.winner = null;
        this.notify();

        const totalWeight = this.items.reduce((sum, item) => sum + item.weight, 0);
        let random = Math.random() * totalWeight;
        let selectedItem = this.items[0];

        for (const item of this.items) {
            random -= item.weight;
            if (random <= 0) {
                selectedItem = item;
                break;
            }
        }

        setTimeout(() => {
            this.isSpinning = false;
            this.winner = selectedItem;
            this.notify();
            // [수정] chat 객체 안전 접근
            if (this.bot.chat && this.bot.chat.connected) {
                this.bot.chat.sendChat(`🎉 룰렛 결과: [ ${selectedItem.text} ] 당첨!`);
            }
        }, 3000);

        return selectedItem;
    }

    public reset() {
        this.items = [];
        this.winner = null;
        this.isSpinning = false;
        this.notify();
    }

    public getState() {
        return { items: this.items, isSpinning: this.isSpinning, winner: this.winner };
    }
}