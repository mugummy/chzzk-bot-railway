import { BotInstance } from './BotInstance';
import { supabase } from './supabase';

export interface RouletteItem {
    id: string;
    label: string;
    weight: number;
    color: string;
}

export class RouletteManager {
    private items: RouletteItem[] = [];
    private onStateChangeCallback: (type: string, payload: any) => void = () => {};

    constructor(private bot: BotInstance) {}

    public setOnStateChangeListener(callback: (type: string, payload: any) => void) {
        this.onStateChangeCallback = callback;
    }

    private notify() {
        this.onStateChangeCallback('rouletteStateUpdate', this.getState());
        this.bot.overlayManager?.updateOverlay('roulette', this.getState());
    }

    public getState() {
        return { items: this.items };
    }

    public updateItems(items: RouletteItem[]) {
        this.items = items;
        this.notify();
    }

    public resetRoulette() {
        // 아이템은 유지하되, 선택된 결과만 초기화
        this.bot.overlayManager?.setView('none');
        // 대시보드에도 초기화 알림
        this.bot.broadcast('rouletteStateUpdate', this.getState());
    }

    public spin() {
        if (this.items.length === 0) return;

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

        if (this.bot.chat && this.bot.settings.getSettings().chatEnabled) {
            this.bot.chat.sendChat(`🎡 룰렛이 돌아갑니다! 과연 결과는?!`);
            setTimeout(() => {
                this.bot.chat?.sendChat(`🎉 결과: [${selectedItem.label}]`);
            }, 5000); 
        }

        // 오버레이 및 대시보드 모두에 이벤트 전송
        this.bot.overlayManager?.startRouletteAnimation(selectedItem);
        // 대시보드가 오버레이 이벤트를 못 받을 수 있으므로 별도 전송 (선택 사항이나 확실하게 하기 위해)
        this.bot.broadcast('spinRouletteResult', { selectedItem });
    }
}
