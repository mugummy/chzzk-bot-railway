export class RouletteManager {
    private items: any[] = [];
    private isSpinning: boolean = false;
    private winner: any = null;
    // [수정] 콜백 시그니처 변경
    private onStateChangeCallback: (type: string, payload: any) => void = () => {};

    constructor(private bot: any, initialData?: any[]) {
        this.items = initialData || [];
    }

    public setOnStateChangeListener(callback: (type: string, payload: any) => void) {
        this.onStateChangeCallback = callback;
    }

    // [핵심] 데이터 실어서 알림
    private notify() {
        this.onStateChangeCallback('rouletteStateUpdate', this.getState());
        this.bot.saveAll();
    }

    public createRoulette(items: any[]) {
        this.items = items;
        this.winner = null;
        this.isSpinning = false;
        this.notify();
    }

    public spin() {
        if (this.items.length === 0 || this.isSpinning) return;
        this.isSpinning = true;
        this.winner = null;
        this.notify();

        const totalWeight = this.items.reduce((sum, item) => sum + (item.weight || 1), 0);
        let random = Math.random() * totalWeight;
        let selected = this.items[0];
        for (const item of this.items) {
            random -= (item.weight || 1);
            if (random <= 0) { selected = item; break; }
        }

        setTimeout(() => {
            this.isSpinning = false;
            this.winner = selected;
            this.notify();
            if (this.bot.chat?.connected) {
                this.bot.chat.sendChat(`🎉 룰렛 결과: [ ${selected.text} ] 당첨!`);
            }
        }, 3000);
    }

    public reset() {
        this.items = [];
        this.winner = null;
        this.isSpinning = false;
        this.notify();
    }

    public getState() { 
        return { 
            items: this.items, 
            isSpinning: this.isSpinning, 
            winner: this.winner 
        }; 
    }
}