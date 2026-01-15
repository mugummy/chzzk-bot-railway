import { BotInstance } from './BotInstance';
import { supabase } from './supabase';

export class OverlayManager {
    private currentView: 'none' | 'vote' | 'draw' | 'roulette' = 'none';
    private isVisible: boolean = true;
    
    // 오버레이 연결된 클라이언트 관리 (WebSocket)
    // 실제 전송은 BotInstance의 브로드캐스트 기능을 이용하거나 여기서 직접 관리
    // 여기서는 BotInstance를 통해 간접적으로 상태를 전파하는 방식을 사용
    
    constructor(private bot: BotInstance) {}

    public getState() {
        return {
            isVisible: this.isVisible,
            currentView: this.currentView
        };
    }

    public setVisible(visible: boolean) {
        this.isVisible = visible;
        this.broadcastState();
    }

    public setView(view: 'none' | 'vote' | 'draw' | 'roulette') {
        this.currentView = view;
        this.broadcastState();
    }

    public updateOverlay(type: string, data: any) {
        if (!this.isVisible) return;
        // 특정 타입의 오버레이 데이터가 변경되었음을 알림
        this.bot.broadcast('overlayDataUpdate', { type, data });
    }

    public startDrawAnimation(winners: any[]) {
        if (this.currentView !== 'draw') this.setView('draw');
        this.bot.broadcast('overlayEvent', { type: 'startDraw', winners });
    }

    public startRouletteAnimation(selectedItem: any) {
        if (this.currentView !== 'roulette') this.setView('roulette');
        this.bot.broadcast('overlayEvent', { type: 'spinRoulette', selectedItem });
    }

    private broadcastState() {
        this.bot.broadcast('overlayStateUpdate', this.getState());
        
        // DB에 상태 저장 (오버레이가 새로고침되어도 유지되도록)
        supabase.from('overlay_settings').upsert({
            channel_id: this.bot.getChannelId(),
            is_visible: this.isVisible,
            current_view: this.currentView
        }).then();
    }
}
