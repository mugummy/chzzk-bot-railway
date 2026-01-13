import { ChatEvent, ChzzkChat, DonationEvent } from 'chzzk';
import ytdl from '@distube/ytdl-core';
import { BotInstance } from './BotInstance';

export interface Song {
    videoId: string;
    title: string;
    thumbnail: string;
    requester: string;
    requestedAt: number;
}

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

    private notify() { this.onStateChangeCallback(); }

    public getState() { return { queue: this.queue, currentSong: this.currentSong }; }

    public async handleCommand(chat: ChatEvent, chzzkChat: ChzzkChat, settings: any) {
        const msg = chat.message.trim();
        const parts = msg.split(' ');
        const cmd = parts[0];

        if (cmd === '!노래') {
            if (parts.length === 1) {
                return chzzkChat.sendChat('🎵 [신청곡 도움말] !노래신청 [제목/링크], !스킵, !대기열, !현재노래');
            }
        }

        if (cmd === '!노래신청' || (cmd === '!노래' && parts.length > 1)) {
            const query = parts.slice(1).join(' ');
            try {
                const song = await this.fetchSongInfo(query, chat.profile.nickname);
                this.queue.push(song);
                this.notify();
                chzzkChat.sendChat(`✅ 대기열 추가: ${song.title} (대기: ${this.queue.length}곡)`);
                
                // 대기열에 곡이 없고 현재 재생 중이 아니면 바로 재생 (자동 재생)
                if (!this.currentSong && this.queue.length === 1) {
                    this.playNext();
                }
            } catch (err: any) {
                chzzkChat.sendChat(`❌ 실패: ${err.message}`);
            }
        } else if (cmd === '!스킵') {
            this.skipSong();
            chzzkChat.sendChat('⏭️ 노래를 스킵했습니다.');
        } else if (cmd === '!대기열') {
            const list = this.queue.slice(0, 3).map((s, i) => `${i+1}. ${s.title}`).join(' / ');
            chzzkChat.sendChat(list ? `📜 대기열: ${list} ...` : '📜 대기열이 비어있습니다.');
        } else if (cmd === '!현재노래') {
            chzzkChat.sendChat(this.currentSong ? `💿 현재 재생 중: ${this.currentSong.title} (신청: ${this.currentSong.requester})` : '🔇 재생 중인 노래가 없습니다.');
        }
    }

    public async addSongFromDonation(donation: DonationEvent, url: string, settings: any) {
        try {
            const song = await this.fetchSongInfo(url, donation.profile.nickname);
            this.queue.push(song); // 도네이션은 우선순위 없이 뒤로 추가 (필요 시 unshift로 변경 가능)
            this.notify();
        } catch (err) {}
    }

    private async fetchSongInfo(query: string, requester: string): Promise<Song> {
        // 간단한 검색 로직 (URL이면 ID 추출, 검색어면 첫 번째 영상)
        let videoId = query;
        if (query.includes('youtu')) {
            try { videoId = ytdl.getURLVideoID(query); } catch { throw new Error('유효하지 않은 링크'); }
        } else {
            // 검색 기능은 ytdl-core에서 제거되었으므로 ytsr 같은 별도 라이브러리가 필요하나, 
            // 여기서는 링크 입력만 우선 지원하거나 에러 처리. 
            // (안정성을 위해 링크 입력을 권장)
            if (!/^[a-zA-Z0-9_-]{11}$/.test(query)) throw new Error('유튜브 링크 또는 영상 ID를 입력해주세요.');
        }

        try {
            const info = await ytdl.getBasicInfo(videoId);
            return {
                videoId,
                title: info.videoDetails.title,
                thumbnail: info.videoDetails.thumbnails[0]?.url,
                requester,
                requestedAt: Date.now()
            };
        } catch (err) { throw new Error('영상 정보를 가져올 수 없습니다.'); }
    }

    public playNext() {
        if (this.queue.length > 0) {
            this.currentSong = this.queue.shift() || null;
            this.notify();
        }
    }

    public skipSong() {
        this.playNext();
    }

    public removeSong(index: number) {
        if (index >= 0 && index < this.queue.length) {
            this.queue.splice(index, 1);
            this.notify();
        }
    }

    public togglePlayPause() { this.notify(); } // 클라이언트 상태 동기화용 트리거

    public getData() { return { songQueue: this.queue, currentSong: this.currentSong }; }
}