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

/**
 * SongManager: 재생 상태(isPlaying)와 현재 곡을 영구적으로 관리합니다.
 */
export class SongManager {
    private queue: Song[] = [];
    private currentSong: Song | null = null;
    private isPlaying: boolean = false; // [추가] 재생/일시정지 상태 추적
    private onStateChangeCallback: (type: string, payload: any) => void = () => {};

    constructor(private bot: BotInstance, initialData: any) {
        this.queue = initialData.songQueue || [];
        this.currentSong = initialData.currentSong || null;
        // DB에서 이전 재생 상태를 불러올 수도 있지만, 안전을 위해 초기값은 false로 설정
    }

    public setOnStateChangeListener(callback: (type: string, payload: any) => void) {
        this.onStateChangeCallback = callback;
    }

    private notify(type: string = 'songStateUpdate') { 
        this.onStateChangeCallback(type, this.getState());
        this.bot.saveAll(); 
    }

    public getState() { 
        return { 
            queue: this.queue, 
            currentSong: this.currentSong,
            isPlaying: this.isPlaying 
        }; 
    }

    public async handleCommand(chat: ChatEvent, chzzkChat: ChzzkChat, settings: any) {
        const msg = chat.message.trim();
        const parts = msg.split(' ');
        const cmd = parts[0];
        const subCmd = parts[1];

        if (cmd !== '!노래') return;
        if (settings.songRequestMode === 'off') return;

        if (!subCmd || subCmd === '도움말') {
            return chzzkChat.sendChat('🎵 [명령어] !노래 신청 [링크], !노래 스킵, !노래 대기열');
        }

        if (subCmd === '신청') {
            if (settings.songRequestMode === 'donation') return chzzkChat.sendChat(`💸 후원으로만 신청 가능합니다.`);
            
            const query = parts.slice(2).join(' ');
            if (!this.isValidYoutubeLink(query)) return chzzkChat.sendChat('❌ 올바른 링크를 입력하세요.');

            try {
                const song = await this.fetchSongInfo(query, chat.profile.nickname);
                this.queue.push(song);
                chzzkChat.sendChat(`✅ 추가됨: ${song.title}`);
                
                // [수정] 현재 재생 중인 곡이 없다면 즉시 재생 시작
                if (!this.currentSong) {
                    this.playNext();
                } else {
                    this.notify();
                }
            } catch (err) { chzzkChat.sendChat('❌ 정보를 가져올 수 없습니다.'); }
        } 
        else if (subCmd === '스킵') {
            if (chat.profile.userRoleCode === 'streamer' || chat.profile.userRoleCode === 'manager') {
                this.skipSong();
                chzzkChat.sendChat('⏭️ 스킵되었습니다.');
            }
        }
        else if (subCmd === '대기열') {
            const list = this.queue.slice(0, 3).map((s, i) => `${i+1}. ${s.title}`).join(' / ');
            chzzkChat.sendChat(list ? `📜 대기열: ${list}...` : '📜 대기열이 비어있습니다.');
        }
    }

    private isValidYoutubeLink(text: string): boolean {
        return /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/.test(text);
    }

    public async addSongFromDonation(donation: DonationEvent, message: string, settings: any) {
        if (donation.payAmount !== (settings.minDonationAmount || 0)) return;
        const match = message.match(/(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
        if (match && match[1]) {
            try {
                const song = await this.fetchSongInfo(match[1], donation.profile.nickname);
                this.queue.push(song);
                if (this.bot.chat) this.bot.chat.sendChat(`💰 후원 곡 추가: ${song.title}`);
                if (!this.currentSong) this.playNext();
                else this.notify();
            } catch (err) {}
        }
    }

    private async fetchSongInfo(videoId: string, requester: string): Promise<Song> {
        const info = await ytdl.getBasicInfo(videoId);
        return {
            videoId,
            title: info.videoDetails.title,
            thumbnail: info.videoDetails.thumbnails[0]?.url,
            requester,
            requestedAt: Date.now()
        };
    }

    public playNext() {
        if (this.queue.length > 0) {
            this.currentSong = this.queue.shift() || null;
            this.isPlaying = true; // 새 곡 시작 시 무조건 재생 상태
            this.notify();
        } else {
            this.currentSong = null;
            this.isPlaying = false;
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

    // [중요] 대시보드 버튼과 플레이어를 이어주는 핵심 로직
    public togglePlayPause() {
        this.isPlaying = !this.isPlaying;
        // 플레이어에게 직접 재생/일시정지 명령을 내리기 위해 별도 타입 전송
        this.onStateChangeCallback('playerControl', { action: this.isPlaying ? 'play' : 'pause' });
        this.notify();
    }

    public getData() { return { songQueue: this.queue, currentSong: this.currentSong, isPlaying: this.isPlaying }; }
}
