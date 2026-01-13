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

    public liveDetail: LiveDetail | null = null;
    public channel: Channel | null = null;

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
        this.settings.setOnStateChangeListener(() => {
            const s = this.settings.getSettings();
            if (this.isLoggedIn && this.chat) {
                this.chat.sendChat(s.chatEnabled ? "🟢 gummybot 응답 기능이 활성화되었습니다." : "🔴 gummybot 응답 기능이 비활성화되었습니다.");
            }
            this.notify('settingsUpdate', s);
            this.saveAll();
        });

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
            await this.refreshLiveInfo(); // 초기 로딩 시 정보 획득

            // 30초마다 정보 갱신 (API 부하 고려)
            this.livePollingTimer = setInterval(() => this.refreshLiveInfo(), 30000);

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
                        this.notify('error', '봇 로그인 실패');
                    }
                });
                await this.chat.connect();
            }
        } catch (err) {}
    }

    // [중요] 라이브 정보 갱신 메서드
    public async refreshLiveInfo() {
        try {
            this.channel = await this.client.channel(this.channelId);
            this.liveDetail = await this.client.live.detail(this.channelId);
        } catch (e) {}
    }

    private async handleChat(chat: ChatEvent) {
        if (this.botUserIdHash && chat.profile.userIdHash === this.botUserIdHash) return;
        this.onChatCallback(chat);
        this.points.awardPoints(chat, this.settings.getSettings());
        await this.votes.handleChat(chat);
        this.draw.handleChat(chat);

        // 채팅 응답 (활성화 시에만)
        if (this.isLoggedIn && this.settings.getSettings().chatEnabled) {
            await this.greet.handleChat(chat, this.chat!);
            const msg = chat.message.trim();
            if (msg.startsWith('!')) {
                const cmd = msg.split(' ')[0];
                // [수정] 노래 관련은 SongManager에게 전적으로 위임 (!노래)
                if (cmd === '!노래') await this.songs.handleCommand(chat, this.chat!, this.settings.getSettings());
                else if (cmd === '!시참') await this.participation.handleCommand(chat, this.chat!);
            }
            if (this.commands.hasCommand(msg)) await this.commands.executeCommand(chat, this.chat!);
            else if (this.counters.hasCounter(msg)) await this.counters.checkAndRespond(chat, this.chat!);
        }
    }

    private async handleDonation(donation: DonationEvent) {
        await this.votes.handleDonation(donation);
        const msg = donation.message || '';
        // [수정] 후원 메시지를 SongManager로 전달하여 링크 파싱 위임
        if (this.isLoggedIn && msg) { 
            try { await this.songs.addSongFromDonation(donation, msg, this.settings.getSettings()); } catch(e) {} 
        }
    }

    public getChannelInfo() { return { channelId: this.channelId, channelName: this.channel?.channelName || "정보 없음", channelImageUrl: this.channel?.channelImageUrl || "https://ssl.pstatic.net/static/nng/glstat/game/favicon.ico", followerCount: this.channel?.followerCount || 0 }; }
    public getLiveStatus() { return { liveTitle: this.liveDetail?.liveTitle || "오프라인", status: this.liveDetail?.status || "CLOSE", concurrentUserCount: this.liveDetail?.concurrentUserCount || 0, category: this.liveDetail?.liveCategoryValue || "미지정" }; }
    public async saveAll() { await DataManager.saveData(this.channelId, { settings: this.settings.getSettings(), commands: this.commands.getCommands(), counters: this.counters.getCounters(), macros: this.macros.getMacros(), points: this.points.getPointsData(), songQueue: this.songs.getData().songQueue, greetData: this.greet.getData(), votes: [this.votes.getState().currentVote], participants: this.participation.getState() }); }
    public async disconnect() { if (this.livePollingTimer) clearInterval(this.livePollingTimer); if (this.chat) { this.macros.stopAllMacros(); await this.chat.disconnect(); this.chat = null; } }
    public getChannelId() { return this.channelId; }
    public getStatus() { return { connected: this.chat?.connected || false, channelId: this.channelId }; }
}
