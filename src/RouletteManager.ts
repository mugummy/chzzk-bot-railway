// src/RouletteManager.ts - 룰렛 시스템

import { ChatBot } from './Bot';
import { v4 as uuidv4 } from 'uuid';

export interface RouletteItem {
    id: string;
    text: string;
    weight: number;
    color?: string;
}

export interface RouletteSession {
    id: string;
    items: RouletteItem[];
    result: RouletteItem | null;
    spinHistory: RouletteItem[];
    createdAt: number;
}

export interface RouletteSettings {
    spinDuration: number;  // 회전 시간 (초)
    showConfetti: boolean;
    playSound: boolean;
}

const DEFAULT_COLORS = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', 
    '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F',
    '#BB8FCE', '#85C1E9', '#F8B500', '#00CED1'
];

export class RouletteManager {
    private currentSession: RouletteSession | null = null;
    private settings: RouletteSettings = {
        spinDuration: 5,
        showConfetti: true,
        playSound: true
    };
    private bot: ChatBot;
    private onStateChangeCallback: () => void = () => {};
    private rouletteHistory: RouletteSession[] = [];

    constructor(bot: ChatBot, initialHistory?: RouletteSession[]) {
        this.bot = bot;
        if (initialHistory) {
            this.rouletteHistory = initialHistory;
        }
    }

    public setOnStateChangeListener(callback: () => void) {
        this.onStateChangeCallback = callback;
    }

    private notifyStateChange() {
        this.onStateChangeCallback();
        this.bot.saveAllData();
    }

    public getState() {
        return {
            currentSession: this.currentSession,
            settings: this.settings,
            rouletteHistory: this.rouletteHistory.slice(-20)
        };
    }

    public createRoulette(items: { text: string; weight: number }[]): { success: boolean; message?: string; session?: RouletteSession } {
        if (items.length < 2) {
            return { success: false, message: '룰렛 항목은 최소 2개 이상이어야 합니다.' };
        }

        const rouletteItems: RouletteItem[] = items.map((item, index) => ({
            id: uuidv4(),
            text: item.text,
            weight: item.weight || 1,
            color: DEFAULT_COLORS[index % DEFAULT_COLORS.length]
        }));

        this.currentSession = {
            id: uuidv4(),
            items: rouletteItems,
            result: null,
            spinHistory: [],
            createdAt: Date.now()
        };

        this.notifyStateChange();
        return { success: true, session: this.currentSession, message: '룰렛이 생성되었습니다.' };
    }

    public importFromVote(voteResults: { optionId: string; text: string; count: number }[]): { success: boolean; message?: string } {
        if (voteResults.length < 2) {
            return { success: false, message: '투표 항목이 2개 이상이어야 합니다.' };
        }

        const items = voteResults.map(r => ({
            text: r.text,
            weight: Math.max(1, r.count)
        }));

        return this.createRoulette(items);
    }

    public spin(): { success: boolean; message?: string; result?: RouletteItem; spinDegree?: number; animationDuration?: number } {
        if (!this.currentSession || this.currentSession.items.length === 0) {
            return { success: false, message: '룰렛이 없습니다.' };
        }

        // 가중치 기반 랜덤 선택
        const totalWeight = this.currentSession.items.reduce((sum, item) => sum + item.weight, 0);
        let random = Math.random() * totalWeight;
        
        let selectedItem: RouletteItem | null = null;
        let selectedIndex = 0;
        
        for (let i = 0; i < this.currentSession.items.length; i++) {
            random -= this.currentSession.items[i].weight;
            if (random <= 0) {
                selectedItem = this.currentSession.items[i];
                selectedIndex = i;
                break;
            }
        }

        if (!selectedItem) {
            selectedItem = this.currentSession.items[this.currentSession.items.length - 1];
            selectedIndex = this.currentSession.items.length - 1;
        }

        this.currentSession.result = selectedItem;
        this.currentSession.spinHistory.push(selectedItem);

        // 룰렛 회전 각도 계산 (항목 위치 + 랜덤 오프셋으로 자연스럽게)
        const itemAngle = 360 / this.currentSession.items.length;
        const baseRotation = 360 * (5 + Math.floor(Math.random() * 3)); // 5~7바퀴 회전
        // 해당 항목 내에서 랜덤 위치 (가운데가 아닌 랜덤 위치)
        const randomOffset = (Math.random() * 0.6 + 0.2) * itemAngle; // 20%~80% 범위 내 랜덤
        const targetAngle = selectedIndex * itemAngle + randomOffset;
        const spinDegree = baseRotation + (360 - targetAngle);

        // 애니메이션 시간 (4~6초)
        const animationDuration = 4000 + Math.random() * 2000;

        this.rouletteHistory.push({ ...this.currentSession });
        if (this.rouletteHistory.length > 50) {
            this.rouletteHistory = this.rouletteHistory.slice(-50);
        }

        this.notifyStateChange();

        return {
            success: true,
            result: selectedItem,
            spinDegree,
            animationDuration, // 동기화를 위해 서버에서 결정된 시간
            message: `🎰 결과: ${selectedItem.text}`
        };
    }

    public addItem(text: string, weight: number = 1): { success: boolean; message?: string } {
        if (!this.currentSession) {
            this.currentSession = {
                id: uuidv4(),
                items: [],
                result: null,
                spinHistory: [],
                createdAt: Date.now()
            };
        }

        const newItem: RouletteItem = {
            id: uuidv4(),
            text,
            weight,
            color: DEFAULT_COLORS[this.currentSession.items.length % DEFAULT_COLORS.length]
        };

        this.currentSession.items.push(newItem);
        this.notifyStateChange();
        return { success: true, message: `"${text}" 항목이 추가되었습니다.` };
    }

    public removeItem(itemId: string): { success: boolean; message?: string } {
        if (!this.currentSession) {
            return { success: false, message: '룰렛이 없습니다.' };
        }

        const index = this.currentSession.items.findIndex(i => i.id === itemId);
        if (index === -1) {
            return { success: false, message: '항목을 찾을 수 없습니다.' };
        }

        const removed = this.currentSession.items.splice(index, 1)[0];
        this.notifyStateChange();
        return { success: true, message: `"${removed.text}" 항목이 제거되었습니다.` };
    }

    public updateItem(itemId: string, text?: string, weight?: number): { success: boolean; message?: string } {
        if (!this.currentSession) {
            return { success: false, message: '룰렛이 없습니다.' };
        }

        const item = this.currentSession.items.find(i => i.id === itemId);
        if (!item) {
            return { success: false, message: '항목을 찾을 수 없습니다.' };
        }

        if (text !== undefined) item.text = text;
        if (weight !== undefined) item.weight = weight;

        this.notifyStateChange();
        return { success: true, message: '항목이 업데이트되었습니다.' };
    }

    public updateSettings(settings: Partial<RouletteSettings>): { success: boolean; message?: string } {
        this.settings = { ...this.settings, ...settings };
        this.notifyStateChange();
        return { success: true, message: '설정이 업데이트되었습니다.' };
    }

    public reset(): { success: boolean; message?: string } {
        this.currentSession = null;
        this.notifyStateChange();
        return { success: true, message: '룰렛이 초기화되었습니다.' };
    }

    public getRouletteHistory(): RouletteSession[] {
        return this.rouletteHistory;
    }
}
