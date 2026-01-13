import { ChatEvent, ChzzkChat } from 'chzzk';

export interface UserPointData {
    nickname: string;
    points: number;
    lastMessageTime: number;
}

/**
 * PointManager: 채팅 기반 포인트 지급 및 랭킹 관리를 담당합니다.
 */
export class PointManager {
    private points: { [userIdHash: string]: UserPointData } = {};
    private onStateChangeCallback: () => void = () => {};

    constructor(initialPoints: { [userId: string]: any }) {
        this.points = initialPoints || {};
    }

    public setOnStateChangeListener(callback: () => void) {
        this.onStateChangeCallback = callback;
    }

    private notify() {
        this.onStateChangeCallback();
    }

    /**
     * 채팅 수신 시 포인트 지급 (설정된 쿨타임 준수)
     */
    public awardPoints(chat: ChatEvent, settings: any) {
        const userId = chat.profile.userIdHash;
        const now = Date.now();
        const perChat = settings.pointsPerChat || 1;
        const cooldown = (settings.pointsCooldown || 60) * 1000;

        if (!this.points[userId]) {
            this.points[userId] = {
                nickname: chat.profile.nickname,
                points: perChat,
                lastMessageTime: now
            };
            this.notify();
        } else {
            const userData = this.points[userId];
            if (now - userData.lastMessageTime >= cooldown) {
                userData.points += perChat;
                userData.nickname = chat.profile.nickname; // 닉네임 최신화
                userData.lastMessageTime = now;
                this.notify();
            }
        }
    }

    /**
     * 수동 포인트 조절 (관리자 기능 등)
     */
    public setPoints(userId: string, amount: number, nickname: string) {
        if (this.points[userId]) {
            this.points[userId].points = amount;
        } else {
            this.points[userId] = {
                nickname,
                points: amount,
                lastMessageTime: 0
            };
        }
        this.notify();
    }

    /**
     * 랭킹 정보 가져오기 (상위 10명)
     */
    public getRanking() {
        return Object.entries(this.points)
            .map(([id, data]) => ({ id, ...data }))
            .sort((a, b) => b.points - a.points)
            .slice(0, 10);
    }

    public getPointsData() {
        return this.points;
    }
}