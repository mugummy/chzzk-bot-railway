import { ChatEvent } from 'chzzk';
import { BotInstance } from './BotInstance';

/**
 * VariableProcessor: 명령어 내의 특수 변수들을 실시간 데이터로 치환합니다.
 */
export class VariableProcessor {
    constructor(private bot: BotInstance) {}

    /**
     * 응답 메시지 내의 모든 변수를 실제 값으로 변환
     */
    public async process(text: string, context: { chat: ChatEvent, commandState?: any }): Promise<string> {
        let result = text;

        // 1. 시청자 정보 (/user)
        result = result.replace(/\/user/g, context.chat.profile.nickname);

        // 2. 채널 정보 (/channel)
        result = result.replace(/\/channel/g, context.chat.profile.nickname); // 기본값

        // 3. 방송 상태 정보 (봇 인스턴스에서 실시간 데이터 가져오기)
        try {
            // 업타임 (/uptime)
            const liveDetail = (this.bot as any).liveDetail; // BotInstance의 liveDetail 참조
            if (liveDetail && liveDetail.openDate) {
                const uptime = this.calculateUptime(liveDetail.openDate);
                result = result.replace(/\/uptime/g, uptime);
            }

            // 시청자 수 (/viewer)
            const viewers = liveDetail?.concurrentUserCount?.toLocaleString() || "0";
            result = result.replace(/\/viewer/g, viewers);

            // 방송 제목 (/title)
            result = result.replace(/\/title/g, liveDetail?.liveTitle || "제목 없음");

            // 카테고리 (/category)
            result = result.replace(/\/category/g, liveDetail?.category || "미지정");
        } catch (e) {
            console.warn('[VariableProcessor] Live data fetch failed:', e);
        }

        // 4. 카운터 정보 (/count)
        if (context.commandState && context.commandState.totalCount !== undefined) {
            result = result.replace(/\/count/g, String(context.commandState.totalCount));
        }

        // 5. 랜덤 선택 (/random)
        // 형식: "치킨/random피자/random떡볶이" 중 하나 선택
        if (result.includes('/random')) {
            const parts = result.split('/random');
            result = parts[Math.floor(Math.random() * parts.length)].trim();
        }

        return result;
    }

    private calculateUptime(openDateStr: string): string {
        const openDate = new Date(openDateStr).getTime();
        const diff = Date.now() - openDate;

        const hours = Math.floor(diff / (1000 * 60 * 60));
        const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        const secs = Math.floor((diff % (1000 * 60)) / 1000);

        let str = "";
        if (hours > 0) str += `${hours}시간 `;
        if (mins > 0) str += `${mins}분 `;
        str += `${secs}초`;
        
        return str;
    }
}
