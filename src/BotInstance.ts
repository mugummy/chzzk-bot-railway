import { ChzzkClient, ChzzkChat, ChatEvent, DonationEvent, LiveDetail, Channel } from 'chzzk';
import { CommandManager } from './CommandManager';
import { SongManager } from './SongManager';
import { VoteManager } from './VoteManager';
import { DataManager } from './DataManager';
import { PointManager } from './PointManager';
import { GreetManager } from './GreetManager';
import { SettingsManager } from './SettingsManager';
import { CounterManager } from './CounterManager';
import { MacroManager } from './MacroManager';
import { ParticipationManager } from './ParticipationManager';
import { DrawManager } from './DrawManager';
import { RouletteManager } from './RouletteManager';

export class BotInstance {
    private client: ChzzkClient;
    public chat: ChzzkChat | null = null;
    private botUserIdHash: string | null = null;
    private isLoggedIn: boolean = false;
    private livePollingTimer: NodeJS.Timeout | null = null;

    // [중요] 실시간 방송 데이터
    public liveDetail: LiveDetail | null = null;
    public channel: Channel | null = null;

    // 매니저
    public commands!: CommandManager;
    public songs!: SongManager;
    public votes!: VoteManager;
    public points!: PointManager;
    public greet!: GreetManager;
    public settings!: SettingsManager;
    public counters!: CounterManager;
    public macros!: MacroManager;
    public participation!: ParticipationManager;
    public draw!: DrawManager;
    public roulette!: RouletteManager;

    private onStateChangeCallback: (type: string, payload: any) => void = () => {};
    private onChatCallback: (chat: ChatEvent) => void = () => {};

    constructor(private channelId: string, nidAuth: string, nidSes: string) {
        const cleanAuth = (nidAuth || '').split(';')[0].replace('NID_AUTH=', '').trim();
        const cleanSes = (nidSes || '').split(';')[0].replace('NID_SES=', '').replace('NID_SESSION=', '').trim();
        this.client = new ChzzkClient({ nidAuth: cleanAuth, nidSession: cleanSes });
    }

    public setOnStateChangeListener(callback: (type: string, payload: any) => void) {
        this.onStateChangeCallback = callback;
    }

    public setOnChatListener(callback: (chat: ChatEvent) => void) {
        this.onChatCallback = callback;
    }

    private notify(type: string, payload: any) { this.onStateChangeCallback(type, payload); }

    public async setup() {
        const data = await DataManager.loadData(this.channelId);

        this.settings = new SettingsManager(data.settings);
        this.settings.setOnStateChangeListener(() => this.notify('settingsUpdate', this.settings.getSettings()));

        this.commands = new CommandManager(this as any, data.commands);
        this.counters = new CounterManager(this as any, data.counters);
        this.macros = new MacroManager(this as any, data.macros);
        this.songs = new SongManager(this as any, data);
        this.points = new PointManager(data.points);
        this.greet = new GreetManager(this as any, data.greetData);
        this.votes = new VoteManager(this as any);
        if (data.votes?.[0]) this.votes.setCurrentVote(data.votes[0]);
        this.draw = new DrawManager(this as any, []);
        this.roulette = new RouletteManager(this as any, []);
        this.participation = new ParticipationManager(this as any, data.participants);

        try {
            // [1] 채널 정보 및 라이브 상태 최초 로드
            this.channel = await this.client.channel(this.channelId);
            this.liveDetail = await this.client.live.detail(this.channelId);
            
            // [2] 10초마다 라이브 상태 갱신 (시청자 수, 카테고리 등)
            this.livePollingTimer = setInterval(async () => {
                try {
                    const latestLive = await this.client.live.detail(this.channelId);
                    if (latestLive) {
                        this.liveDetail = latestLive;
                        // 상태가 바뀌었을 때만 알림을 보내는 로직을 추가할 수 있으나, 
                        // 지금은 확실한 갱신을 위해 주기적으로 보냅니다.
                        // (메인 서버에서 requestData 시 최신 값을 주도록 보장)
                    }
                } catch (e) {}
            }, 10000);

            if (this.liveDetail?.chatChannelId) {
                this.chat = this.client.chat({ channelId: this.channelId, chatChannelId: this.liveDetail.chatChannelId });
                this.chat.on('chat', (chat) => this.handleChat(chat));
                this.chat.on('donation', (donation) => this.handleDonation(donation));
                
                this.chat.on('connect', async () => {
                    try {
                        const self = await this.chat?.selfProfile();
                        this.botUserIdHash = self?.userIdHash || null;
                        this.isLoggedIn = true;
                        this.macros.setChatClient(this.chat!);
                    } catch (e) {
                        this.isLoggedIn = false;
                        this.notify('error', '봇 로그인 실패 (채팅 전송 불가)');
                    }
                });
                await this.chat.connect();
            }
        } catch (err) {
            console.error('[BotInstance] Setup Error:', err);
        }
    }

    private async handleChat(chat: ChatEvent) {
        if (this.botUserIdHash && chat.profile.userIdHash === this.botUserIdHash) return;
        this.onChatCallback(chat);
        
        this.points.awardPoints(chat, this.settings.getSettings());
        await this.votes.handleChat(chat);
        this.draw.handleChat(chat);

        if (this.isLoggedIn && this.settings.getSettings().chatEnabled) {
            await this.greet.handleChat(chat, this.chat!);
            const msg = chat.message.trim();
            if (msg.startsWith('!')) {
                const cmd = msg.split(' ')[0];
                if (['!노래', '!신청', '!스킵'].includes(cmd)) await this.songs.handleCommand(chat, this.chat!, this.settings.getSettings());
                else if (cmd === '!시참') await this.participation.handleCommand(chat, this.chat!);
            }
            if (this.commands.hasCommand(msg)) await this.commands.executeCommand(chat, this.chat!);
            else if (this.counters.hasCounter(msg)) await this.counters.checkAndRespond(chat, this.chat!);
        }
    }

    private async handleDonation(donation: DonationEvent) {
        await this.votes.handleDonation(donation);
        const match = donation.message?.match(/(?:https?:\/\/)?(?:www\.)?youtu\.?be(?:\.com\/watch\?v=|\/)([a-zA-Z0-9_-]{11})/);
        if (this.isLoggedIn && match) { try { await this.songs.addSongFromDonation(donation, match[0], this.settings.getSettings()); } catch(e) {} }
    }

    // [중요] 대시보드에 보낼 채널 정보 객체 구성
    public getChannelInfo() {
        return {
            channelId: this.channelId,
            channelName: this.channel?.channelName || "정보 없음",
            channelImageUrl: this.channel?.channelImageUrl || "https://ssl.pstatic.net/static/nng/glstat/game/favicon.ico",
            followerCount: this.channel?.followerCount || 0
        };
    }

    // [중요] 대시보드에 보낼 라이브 상태 객체 구성
    public getLiveStatus() {
        return {
            liveTitle: this.liveDetail?.liveTitle || "오프라인",
            status: this.liveDetail?.status || "CLOSE",
            concurrentUserCount: this.liveDetail?.concurrentUserCount || 0,
            category: this.liveDetail?.liveCategoryValue || "미지정"
        };
    }

    public async saveAll() {
        await DataManager.saveData(this.channelId, { settings: this.settings.getSettings(), commands: this.commands.getCommands(), counters: this.counters.getCounters(), macros: this.macros.getMacros(), points: this.points.getPointsData(), songQueue: this.songs.getData().songQueue, greetData: this.greet.getData(), votes: [this.votes.getState().currentVote], participants: this.participation.getState() });
    }

    public async disconnect() { 
        if (this.livePollingTimer) clearInterval(this.livePollingTimer);
        if (this.chat) { this.macros.stopAllMacros(); await this.chat.disconnect(); this.chat = null; } 
    }
}
