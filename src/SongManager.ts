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
        const subCmd = parts[1];

        if (cmd !== '!노래') return;

        if (!subCmd || subCmd === '도움말') {
            return chzzkChat.sendChat('🎵 [명령어] !노래 신청 [링크], !노래 스킵, !노래 대기열, !노래 현재');
        }

        if (subCmd === '신청') {
            const query = parts.slice(2).join(' ');
            if (!query) return chzzkChat.sendChat('❌ 사용법: !노래 신청 [유튜브 링크]');
            
            try {
                const song = await this.fetchSongInfo(query, chat.profile.nickname);
                this.queue.push(song);
                this.notify();
                chzzkChat.sendChat(`✅ 추가됨: ${song.title}`);
                if (!this.currentSong && this.queue.length === 1) this.playNext();
            } catch (err) {
                chzzkChat.sendChat('❌ 영상 정보를 가져올 수 없습니다.');
            }
        } 
        
        else if (subCmd === '스킵') {
            // [보안] 권한 체크: 스트리머 또는 매니저만 가능
            const role = chat.profile.userRoleCode; // streamer, manager, etc.
            const isAuthorized = role === 'streamer' || role === 'manager' || chat.profile.badge?.imageUrl?.includes('manager');

            if (isAuthorized) {
                this.skipSong();
                chzzkChat.sendChat('⏭️ 노래를 스킵했습니다.');
            } else {
                chzzkChat.sendChat('🛡️ 스킵 권한이 없습니다 (매니저 전용)');
            }
        } 
        
        else if (subCmd === '대기열') {
            if (this.queue.length === 0) return chzzkChat.sendChat('📜 대기열이 비어있습니다.');
            const list = this.queue.slice(0, 3).map((s, i) => `${i+1}. ${s.title}`).join(' / ');
            chzzkChat.sendChat(`📜 대기열 (${this.queue.length}곡): ${list} ...`);
        } 
        
        else if (subCmd === '현재' || subCmd === '현재노래') {
            chzzkChat.sendChat(this.currentSong ? `💿 재생 중: ${this.currentSong.title}` : '🔇 재생 중인 노래가 없습니다.');
        }
    }

    public async addSongFromDonation(donation: DonationEvent, url: string, settings: any) {
        try {
            const song = await this.fetchSongInfo(url, donation.profile.nickname);
            this.queue.push(song);
            this.notify();
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
        } catch (err) { throw new Error('Info Error'); }
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