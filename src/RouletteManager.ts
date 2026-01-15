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

    public spin() {
        if (this.items.length === 0) return;

        // 가중치 기반 랜덤 선택
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

        // 오버레이에 회전 명령
        this.bot.overlayManager?.startRouletteAnimation(selectedItem);
    }
}
