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
        const cmd = parts[0]; // !노래
        const subCmd = parts[1]; // 신청, 스킵, 대기열 등

        if (cmd !== '!노래') return;

        // [수정] 명령어 체계 통합 (!노래 [서브명령어])
        if (!subCmd || subCmd === '도움말') {
            return chzzkChat.sendChat('🎵 [음악 봇 사용법] !노래 신청 [링크], !노래 스킵, !노래 대기열, !노래 현재');
        }

        if (subCmd === '신청') {
            const query = parts.slice(2).join(' ');
            if (!query) return chzzkChat.sendChat('❌ 유튜브 링크를 입력해주세요. (예: !노래 신청 https://youtu.be/...)');
            
            try {
                const song = await this.fetchSongInfo(query, chat.profile.nickname);
                this.queue.push(song);
                this.notify();
                chzzkChat.sendChat(`✅ 대기열 추가: ${song.title} (현재 대기: ${this.queue.length}곡)`);
                
                // 자동 재생 (대기열 1개이고 현재 재생 중 아니면)
                if (!this.currentSong && this.queue.length === 1) {
                    this.playNext();
                }
            } catch (err: any) {
                chzzkChat.sendChat(`❌ 신청 실패: 유효하지 않은 링크입니다.`);
            }
        } else if (subCmd === '스킵') {
            this.skipSong();
            chzzkChat.sendChat('⏭️ 관리자가 노래를 스킵했습니다.');
        } else if (subCmd === '대기열') {
            if (this.queue.length === 0) return chzzkChat.sendChat('📜 대기열이 비어있습니다.');
            const list = this.queue.slice(0, 3).map((s, i) => `${i+1}. ${s.title}`).join(' / ');
            chzzkChat.sendChat(`📜 대기열 (총 ${this.queue.length}곡): ${list} ...`);
        } else if (subCmd === '현재' || subCmd === '현재노래') {
            chzzkChat.sendChat(this.currentSong ? `💿 Now Playing: ${this.currentSong.title} (신청자: ${this.currentSong.requester})` : '🔇 재생 중인 노래가 없습니다.');
        }
    }

    public async addSongFromDonation(donation: DonationEvent, url: string, settings: any) {
        try {
            const song = await this.fetchSongInfo(url, donation.profile.nickname);
            this.queue.push(song);
            this.notify();
            // 도네이션은 자동 재생 트리거 포함
            if (!this.currentSong && this.queue.length === 1) this.playNext();
        } catch (err) {}
    }

    private async fetchSongInfo(query: string, requester: string): Promise<Song> {
        let videoId = query;
        if (query.includes('youtu')) {
            try { videoId = ytdl.getURLVideoID(query); } catch { throw new Error('Invalid URL'); }
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
        } catch (err) { throw new Error('Video Not Found'); }
    }

    public playNext() {
        if (this.queue.length > 0) {
            this.currentSong = this.queue.shift() || null;
            this.notify();
        } else {
            this.currentSong = null;
            this.notify();
        }
    }

    public skipSong() { this.playNext(); }

    public removeSong(index: number) {
        if (index >= 0 && index < this.queue.length) {
            this.queue.splice(index, 1);
            this.notify();
        }
    }

    public togglePlayPause() { this.notify(); }

    public getData() { return { songQueue: this.queue, currentSong: this.currentSong }; }
}
