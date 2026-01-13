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

    // 대시보드 및 연동용 데이터
    public liveDetail: LiveDetail | null = null;
    public channel: Channel | null = null;

    // 기능 매니저
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
        // [수정] 쿠키 값 정제 (NID_AUTH= 등의 접두사 자동 제거)
        const cleanAuth = nidAuth.split(';')[0].replace('NID_AUTH=', '').trim();
        const cleanSes = nidSes.split(';')[0].replace('NID_SES=', '').replace('NID_SESSION=', '').trim();

        console.log(`[BotInstance] Initializing with clean tokens (Len: ${cleanAuth.length}, ${cleanSes.length})`);
        
        this.client = new ChzzkClient({ 
            nidAuth: cleanAuth, 
            nidSession: cleanSes 
        });
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

        // 매니저 객체 생성 및 배선
        this.settings = new SettingsManager(data.settings);
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
            // 채널 정보 로드
            this.channel = await this.client.channel(this.channelId);
            this.liveDetail = await this.client.live.detail(this.channelId);
            
            if (this.liveDetail?.chatChannelId) {
                this.chat = this.client.chat({ 
                    channelId: this.channelId, 
                    chatChannelId: this.liveDetail.chatChannelId 
                });
                
                this.chat.on('chat', (chat) => this.handleChat(chat));
                this.chat.on('donation', (donation) => this.handleDonation(donation));
                
                this.chat.on('connect', async () => {
                    try {
                        const self = await this.chat?.selfProfile();
                        this.botUserIdHash = self?.userIdHash || null;
                        this.macros.setChatClient(this.chat!);
                        console.log(`[BotInstance] Success! gummybot logged in as: ${self?.nickname}`);
                    } catch (e) {
                        console.error('[BotInstance] Login fail - Tokens might be expired or invalid');
                        this.notify('error', '치지직 로그인 세션이 유효하지 않습니다. 환경변수를 업데이트하세요.');
                    }
                });

                await this.chat.connect();
            }
        } catch (err) {
            console.error('[BotInstance] Critical Setup Error:', err);
        }
    }

    private async handleChat(chat: ChatEvent) {
        if (this.botUserIdHash && chat.profile.userIdHash === this.botUserIdHash) return;
        this.onChatCallback(chat);

        await this.greet.handleChat(chat, this.chat!);
        this.points.awardPoints(chat, this.settings.getSettings());
        await this.votes.handleChat(chat);
        this.draw.handleChat(chat);

        if (this.settings.getSettings().chatEnabled) {
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
        if (match) { try { await this.songs.addSongFromDonation(donation, match[0], this.settings.getSettings()); } catch(e) {} }
    }

    // 대시보드 필수 정보 반환 메서드
    public getChannelInfo() {
        return {
            channelId: this.channelId,
            channelName: this.channel?.channelName || "정보 없음",
            channelImageUrl: this.channel?.channelImageUrl || "",
            followerCount: this.channel?.followerCount || 0
        };
    }

    public getLiveStatus() {
        return {
            liveTitle: this.liveDetail?.liveTitle || "오프라인",
            status: this.liveDetail?.status || "CLOSE",
            concurrentUserCount: this.liveDetail?.concurrentUserCount || 0,
            category: this.liveDetail?.category || "미지정"
        };
    }

    public async saveAll() {
        await DataManager.saveData(this.channelId, { settings: this.settings.getSettings(), commands: this.commands.getCommands(), counters: this.counters.getCounters(), macros: this.macros.getMacros(), points: this.points.getPointsData(), songQueue: this.songs.getData().songQueue, greetData: this.greet.getData(), votes: [this.votes.getState().currentVote], participants: this.participation.getState() });
    }

    public async disconnect() { if (this.chat) { this.macros.stopAllMacros(); await this.chat.disconnect(); this.chat = null; } }
    public getChannelId() { return this.channelId; }
    public getStatus() { return { connected: this.chat?.connected || false, channelId: this.channelId }; }
}