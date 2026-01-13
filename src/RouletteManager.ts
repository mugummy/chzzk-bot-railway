import { BotInstance } from './BotInstance';

/**
 * RouletteManager: 실시간 룰렛 생성 및 당첨자 선정을 관리합니다.
 */
export class RouletteManager {
    private currentSession: any = null;
    private onStateChangeCallback: () => void = () => {};

    constructor(private bot: BotInstance, initialData: any) {}

    public setOnStateChangeListener(callback: () => void) {
        this.onStateChangeCallback = callback;
    }

    private notify() { this.onStateChangeCallback(); }

    /**
     * 룰렛 생성 (main.ts의 createRoulette 명령어와 매칭)
     */
    public createRoulette(items: any[]) {
        this.currentSession = {
            items: items.map((item, i) => ({ id: i + 1, text: item.text, weight: item.weight })),
            isActive: true,
            winner: null
        };
        this.notify();
    }

    /**
     * 룰렛 돌리기
     */
    public spin() {
        if (!this.currentSession || this.currentSession.items.length === 0) return;

        const items = this.currentSession.items;
        const totalWeight = items.reduce((acc: number, i: any) => acc + i.weight, 0);
        let random = Math.random() * totalWeight;

        let winner = items[0];
        for (const item of items) {
            if (random < item.weight) {
                winner = item;
                break;
            }
            random -= item.weight;
        }

        this.currentSession.winner = winner;
        this.notify();
        this.bot.chat?.sendChat(`🎰 룰렛 결과: [${winner.text}] 당첨!`);
        return winner;
    }

    public reset() {
        this.currentSession = null;
        this.notify();
    }

    public getState() { return { currentSession: this.currentSession }; }
}