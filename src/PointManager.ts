import { ChatEvent } from 'chzzk';
import { BotSettings } from './SettingsManager';

export interface UserPoint {
    nickname: string;
    points: number;
    lastMessageTime: number;
}

export class PointManager {
    private points: { [userIdHash: string]: UserPoint } = {};
    private onStateChangeCallback: (type: string, payload: any) => void = () => {};

    // [수정] 중복된 생성자 제거 및 단일화
    constructor(initialData?: { [userIdHash: string]: UserPoint }) {
        this.points = initialData || {};
    }

    public setOnStateChangeListener(callback: (type: string, payload: any) => void) {
        this.onStateChangeCallback = callback;
    }

    private notify() {
        this.onStateChangeCallback('pointsUpdate', this.getPointsData());
    }

    public awardPoints(chat: ChatEvent, settings: BotSettings) {
        const userId = chat.profile.userIdHash;
        const now = Date.now();
        const user = this.points[userId] || { nickname: chat.profile.nickname, points: 0, lastMessageTime: 0 };

        // 쿨타임 체크 (밀리초 단위 변환)
        if (now - user.lastMessageTime >= settings.pointsCooldown * 1000) {
            user.points += settings.pointsPerChat;
            user.lastMessageTime = now;
            user.nickname = chat.profile.nickname; // 닉네임 갱신
            this.points[userId] = user;
            this.notify(); // 저장 트리거
        }
    }

    public getPoints(userId: string): number {
        return this.points[userId]?.points || 0;
    }

    public getPointsData() {
        return this.points;
    }
}