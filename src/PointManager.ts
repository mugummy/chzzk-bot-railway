import { ChatEvent, ChzzkChat } from "chzzk";
import { BotSettings } from "./SettingsManager";

export interface UserPoints { [userIdHash: string]: { nickname: string; points: number; lastMessageTime: number; } }
export class PointManager {
    private pointsData: UserPoints = {};
    private onStateChangeCallback: () => void = () => {};
    private lastBroadcastTime: number = 0;
    private pendingBroadcast: NodeJS.Timeout | null = null;

    constructor(initialPoints: UserPoints) {
        this.pointsData = initialPoints || {};
    }

    public setOnStateChangeListener(callback: () => void) {
        this.onStateChangeCallback = callback;
    }

    private notifyStateChange() {
        // 포인트는 자주 변경되므로 5초마다만 브로드캐스트 (성능 최적화)
        const now = Date.now();
        if (now - this.lastBroadcastTime > 5000) {
            this.lastBroadcastTime = now;
            this.onStateChangeCallback();
        } else if (!this.pendingBroadcast) {
            // 5초 후에 브로드캐스트 예약
            this.pendingBroadcast = setTimeout(() => {
                this.pendingBroadcast = null;
                this.lastBroadcastTime = Date.now();
                this.onStateChangeCallback();
            }, 5000 - (now - this.lastBroadcastTime));
        }
    }

    public awardPoints(chat: ChatEvent, settings: BotSettings): void {
        if (!settings.pointSystemEnabled) return;
        const now = Date.now();
        const user = this.pointsData[chat.profile.userIdHash];
        const pointCooldownMs = settings.pointCooldown * 1000;
        if (user) {
            if (now - user.lastMessageTime > pointCooldownMs) {
                user.points = Number(user.points) + Number(settings.pointsPerChat);
                user.lastMessageTime = now;
                user.nickname = chat.profile.nickname;
                this.notifyStateChange();
            }
        } else {
            this.pointsData[chat.profile.userIdHash] = { nickname: chat.profile.nickname, points: Number(settings.pointsPerChat), lastMessageTime: now };
            this.notifyStateChange();
        }
    }
    public handleCommand(chat: ChatEvent, chzzkChat: ChzzkChat, settings: BotSettings): void {
        const message = chat.message.trim();
        const unit = settings.pointsUnit || '포인트';

        if (message === '!포인트') {
            chzzkChat.sendChat("포인트 명령어: !포인트 확인 (내 포인트 확인), !포인트 랭킹 (랭킹 확인)");
        } else if (message === '!포인트 확인') {
            const user = this.pointsData[chat.profile.userIdHash];
            const userPoints = user && typeof user.points === 'number' ? user.points : 0;
            chzzkChat.sendChat(`${chat.profile.nickname}님의 현재 포인트는 ${userPoints.toLocaleString()}${unit}입니다.`);
        } else if (message === '!포인트 랭킹') {
            // 유효한 데이터만 필터링하고 정렬
            const validUsers = Object.values(this.pointsData).filter(u =>
                u && typeof u.nickname === 'string' && typeof u.points === 'number'
            );
            const sortedUsers = validUsers.sort((a, b) => (b.points || 0) - (a.points || 0)).slice(0, 5);

            if (sortedUsers.length === 0) {
                chzzkChat.sendChat("🏆 포인트 랭킹 - 아직 데이터가 없습니다.");
                return;
            }

            let response = "🏆 포인트 랭킹 TOP 5 🏆\n";
            sortedUsers.forEach((u, i) => {
                const nickname = u.nickname || '알 수 없음';
                const points = typeof u.points === 'number' ? u.points : 0;
                response += `${i + 1}위: ${nickname} (${points.toLocaleString()}${unit})\n`;
            });
            chzzkChat.sendChat(response);
        }
    }

    // 저장용 - 원본 데이터 반환
    public getPointsData(): UserPoints {
        return this.pointsData;
    }

    // UI용 - 리더보드 포함
    public getPointsDataForUI(): { pointsData: UserPoints; leaderboard: { nickname: string; points: number; lastMessageTime: number; }[] } {
        const validUsers = Object.values(this.pointsData).filter(u =>
            u && typeof u.nickname === 'string' && typeof u.points === 'number'
        );
        const leaderboard = validUsers.sort((a, b) => (b.points || 0) - (a.points || 0));
        return {
            pointsData: this.pointsData,
            leaderboard: leaderboard
        };
    }

    // 외부에서 포인트 업데이트
    public updateUserPoints(userIdHash: string, nickname: string, points: number): void {
        this.pointsData[userIdHash] = {
            nickname,
            points,
            lastMessageTime: Date.now()
        };
    }
}
