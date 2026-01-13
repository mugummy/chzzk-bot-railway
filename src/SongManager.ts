import { ChatEvent, ChzzkChat, DonationEvent } from 'chzzk';
import ytdl from 'ytdl-core';
import { BotInstance } from './BotInstance';

export interface Song {
    videoId: string;
    title: string;
    thumbnail: string;
    requester: string;
    requestedAt: number;
}

/**
 * SongManager: 신청곡 대기열 관리 및 유튜브 연동을 담당합니다.
 */
export class SongManager {
    private queue: Song[] = [];
    private currentSong: Song | null = null;
    private onStateChangeCallback: () => void = () => {};

    constructor(private bot: BotInstance, initialData: any) {
        this.queue = initialData.songQueue || [];
    }

    public setOnStateChangeListener(callback: () => void) {
        this.onStateChangeCallback = callback;
    }

    private notify() {
        this.onStateChangeCallback();
    }

    public getState() {
        return {
            queue: this.queue,
            currentSong: this.currentSong
        };
    }

    /**
     * 채팅 명령어 (!노래신청 [URL]) 처리
     */
    public async handleCommand(chat: ChatEvent, chzzkChat: ChzzkChat, settings: any) {
        const msg = chat.message.trim();
        const parts = msg.split(' ');
        const cmd = parts[0];

        if (cmd === '!노래신청' || cmd === '!노래') {
            const query = parts.slice(1).join(' ');
            if (!query) return chzzkChat.sendChat('사용법: !노래 [유튜브링크]');
            
            try {
                const song = await this.fetchSongInfo(query, chat.profile.nickname);
                this.queue.push(song);
                chzzkChat.sendChat(`🎵 ${song.title} 곡이 대기열에 추가되었습니다! (대기: ${this.queue.length}곡)`);
                this.notify();
            } catch (err: any) {
                chzzkChat.sendChat(`❌ 신청 실패: ${err.message}`);
            }
        } else if (cmd === '!스킵') {
            // 스트리머 또는 권한자 체크 로직 추가 가능
            this.skipSong();
            chzzkChat.sendChat('⏭️ 현재 곡을 스킵했습니다.');
        }
    }

    /**
     * 후원 메시지로 신청된 노래 처리
     */
    public async addSongFromDonation(donation: DonationEvent, url: string, settings: any) {
        try {
            const song = await this.fetchSongInfo(url, donation.profile.nickname);
            this.queue.push(song);
            this.notify();
        } catch (err) {
            console.error('[SongManager] Donation song failed:', err);
        }
    }

    /**
     * 유튜브 정보 추출 (ytdl-core)
     */
    private async fetchSongInfo(query: string, requester: string): Promise<Song> {
        let videoId = '';
        if (ytdl.validateURL(query)) videoId = ytdl.getURLVideoID(query);
        else if (ytdl.validateID(query)) videoId = query;
        else throw new Error('올바른 유튜브 링크가 아닙니다.');

        try {
            const info = await ytdl.getBasicInfo(videoId);
            return {
                videoId,
                title: info.videoDetails.title,
                thumbnail: info.videoDetails.thumbnails[0]?.url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
                requester,
                requestedAt: Date.now()
            };
        } catch (err) {
            // 정보 로딩 실패 시 비디오 ID만으로 생성 (안전망)
            return {
                videoId,
                title: '유튜브 노래 (정보 로드 실패)',
                thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
                requester,
                requestedAt: Date.now()
            };
        }
    }

    public skipSong() {
        if (this.queue.length > 0) {
            this.currentSong = this.queue.shift() || null;
        } else {
            this.currentSong = null;
        }
        this.notify();
    }

    public togglePlayPause() {
        // 플레이어에 메시지 전달 (WebSocket 브로드캐스트를 통해 처리됨)
        this.notify();
    }

    public getData() {
        return { songQueue: this.queue, currentSong: this.currentSong };
    }
}
