import { supabase } from './supabase';

interface RouletteItem {
    id: string;
    label: string;
    weight: number;
    color?: string;
    position: number;
}

interface RouletteState {
    items: RouletteItem[];
    isSpinning: boolean;
    result: RouletteItem | null;
}

export class RouletteManager {
    private bot: any;
    private channelId: string;
    private items: RouletteItem[] = [];
    private isSpinning: boolean = false;
    private result: RouletteItem | null = null;
    private onStateChangeCallback: (type: string, payload: any) => void = () => {};

    constructor(bot: any) {
        this.bot = bot;
        this.channelId = bot.getChannelId();
        this.loadItems();
    }

    setOnStateChangeListener(callback: (type: string, payload: any) => void) {
        this.onStateChangeCallback = callback;
    }

    private notify() {
        this.onStateChangeCallback('rouletteStateUpdate', this.getState());
    }

    getState(): RouletteState {
        return {
            items: this.items,
            isSpinning: this.isSpinning,
            result: this.result
        };
    }

    private async loadItems() {
        try {
            const { data } = await supabase
                .from('roulette_items')
                .select('*')
                .eq('channel_id', this.channelId)
                .order('position');

            if (data && data.length > 0) {
                this.items = data.map(item => ({
                    id: item.id,
                    label: item.label,
                    weight: item.weight,
                    color: item.color,
                    position: item.position
                }));
            } else {
                // Default items
                this.items = [
                    { id: '1', label: '꽝', weight: 30, color: '#ef4444', position: 0 },
                    { id: '2', label: '한번 더', weight: 20, color: '#3b82f6', position: 1 },
                    { id: '3', label: '당첨!', weight: 10, color: '#22c55e', position: 2 }
                ];
            }
            this.notify();
        } catch (e) {
            console.error('[RouletteManager] Failed to load items:', e);
        }
    }

    async updateItems(newItems: { label: string; weight: number; color?: string }[]) {
        try {
            // Delete existing items
            await supabase
                .from('roulette_items')
                .delete()
                .eq('channel_id', this.channelId);

            // Insert new items
            const itemsToInsert = newItems.map((item, idx) => ({
                channel_id: this.channelId,
                label: item.label,
                weight: item.weight,
                color: item.color || this.getDefaultColor(idx),
                position: idx
            }));

            const { data, error } = await supabase
                .from('roulette_items')
                .insert(itemsToInsert)
                .select();

            if (error) throw error;

            this.items = (data || []).map(item => ({
                id: item.id,
                label: item.label,
                weight: item.weight,
                color: item.color,
                position: item.position
            }));

            this.notify();
        } catch (e) {
            console.error('[RouletteManager] Failed to update items:', e);
        }
    }

    private getDefaultColor(index: number): string {
        const colors = ['#3b82f6', '#8b5cf6', '#ec4899', '#10b981', '#f59e0b', '#6366f1', '#ef4444', '#14b8a6'];
        return colors[index % colors.length];
    }

    async spin(): Promise<RouletteItem | null> {
        if (this.items.length < 2) return null;
        if (this.isSpinning) return null;

        this.isSpinning = true;
        this.result = null;
        this.notify();

        // Calculate winner based on weights
        const totalWeight = this.items.reduce((sum, item) => sum + item.weight, 0);
        let random = Math.random() * totalWeight;

        let winner: RouletteItem | null = null;
        for (const item of this.items) {
            random -= item.weight;
            if (random <= 0) {
                winner = item;
                break;
            }
        }

        if (!winner) {
            winner = this.items[this.items.length - 1];
        }

        // Simulate spin duration (client will handle animation)
        // Server just returns the result
        this.result = winner;
        this.isSpinning = false;
        this.notify();

        // Announce in chat
        if (this.bot.chat) {
            await this.bot.chat.sendChat(`[룰렛 결과] ${winner.label}!`);
        }

        return winner;
    }

    async resetRoulette() {
        this.result = null;
        this.isSpinning = false;
        this.notify();
    }
}
