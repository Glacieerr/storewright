import { useEffect, useLayoutEffect, useState } from 'react';
import { backroomLayout } from '@storewright/store-config';
import { useApp } from '../state/store';
import { clock, setPlaying, setSpeed, setTime } from '../state/clock';
import { t } from '../i18n';

/**
 * 导览：一步一步介绍模拟器。每一步可以把镜头移到场景里的某个位置、切换数据标签，
 * 并用聚光框圈出界面上的对应区域。→ / Enter 下一步，← 上一步，Esc 退出。
 */

interface Step {
  title: string;
  body: string;
  /** 要圈出的界面元素（CSS 选择器）；没有时只显示说明卡片 */
  target?: string;
  /** 卡片放在目标的哪一侧 */
  side?: 'below' | 'above' | 'left';
  enter?: () => void;
}

const SEEN_KEY = 'storewright.tour.seen';

export function tourSeen(): boolean {
  // 嵌在展示页里（门店实况、全天仿真）时不弹导览邀请
  const q = new URLSearchParams(location.search);
  if (q.get('live') === 'demo' || q.get('autoplay') === '1') return true;
  try {
    return window.localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return true;
  }
}

function markSeen(): void {
  try {
    window.localStorage.setItem(SEEN_KEY, '1');
  } catch {
    // 本机存储不可用时下次还会提示
  }
}

function steps(): Step[] {
  const app = useApp.getState;
  const leaveEdit = () => {
    if (app().mode === 'edit') app().exitEdit(true);
  };
  const geo = () => app().simGeo;
  const live = () => {
    leaveEdit();
    app().setFollow(undefined);
    app().select(undefined);
  };
  return [
    {
      title: t('欢迎来到 Storewright'),
      body: t('这是一个门店运营模拟器：线上订单在店里拣货、暂存，顾客到停车场取货；后仓收货、夜班补货也都在同一次仿真里。左边是门店，右边是实时数据，下面是时间轴。'),
      enter: () => {
        live();
        app().setTab('live');
        app().zoom('reset');
        const open = app().simModel.config.hours.openMin * 60;
        if (clock.time < open + 2 * 3600) setTime(open + 3.5 * 3600);
        setSpeed(60);
        setPlaying(true);
      },
    },
    {
      title: t('拣货'),
      body: t('绿色的是拣货员：推着拣货车按优化后的路线在货架间拣货，一车同时拣几张订单，框按温区和重量分开。右上角的卡片显示这名员工现在在做什么。'),
      enter: () => {
        live();
        const a = app().timeline?.associates.find((x) => x.role === 'pick' && x.segments.some((s) => s.t0 <= clock.time && s.t1 >= clock.time && s.kind === 'MOVE'));
        const f = geo().floors[0];
        if (f) app().frame((f.minX + f.maxX) / 2, 0, (f.minZ + f.maxZ) / 2, 22);
        if (a) {
          app().select({ type: 'associate', id: a.id });
          app().setFollow(a.id);
        }
      },
    },
    {
      title: t('暂存与交付'),
      body: t('紫色的暂存员把拣好的框放进暂存格位（常温、冷藏、冷冻分开）。顾客快到时，橙色的交付员取出订单，推到车边交给顾客。'),
      enter: () => {
        live();
        const sp = app().simModel.config.layout.points.staging;
        app().frame(sp.x + 4, 0, sp.y + 2, 14);
      },
    },
    {
      title: t('停车场取货'),
      body: t('线上取货车位离交付门口最近。车位上的圆环表示顾客在等：蓝色是刚到，红色是等太久。路况会推迟顾客到店的时间。'),
      enter: () => {
        live();
        const s = geo().lot.pickupSign;
        app().frame(s.x, 0, s.z - 6, 18);
      },
    },
    {
      title: t('后仓与到货'),
      body: t('卡车按时到卸货门，叉车把托盘卸到收货区、再放进货架；关门后夜班从货架取货，推到店里逐箱上架。后仓大小和叉车数量都能在「门店定制」里调整。'),
      enter: () => {
        live();
        const b = backroomLayout(app().simModel.config);
        app().frame((b.zone.x0 + b.zone.x1) / 2 + 6, 0, (b.zone.z0 + b.zone.z1) / 2, 16);
      },
    },
    {
      title: t('时间轴'),
      body: t('拖动时间轴跳到一天中的任何时刻，选择倍速播放；空格键播放或暂停。时间轴会延伸到第二天开门，好看到夜班补货。'),
      target: '.timeline',
      side: 'above',
      enter: () => {
        live();
        app().zoom('reset');
      },
    },
    {
      title: t('实时数据'),
      body: t('指标卡片和全天曲线随播放实时更新，播放到哪里实线就画到哪里。下面可以调整各岗位人数、注入订单高峰、切换天气和突发状况，结果马上重算。'),
      target: '.data-pane',
      side: 'left',
      enter: () => {
        live();
        app().setTab('live');
      },
    },
    {
      title: t('策略对比'),
      body: t('同一门店、同一订单流、同一排班下，三种作业策略的全天结果并排对比：等待时间、商品安全、作业效率，好坏用颜色标出。'),
      target: '.data-pane',
      side: 'left',
      enter: () => {
        live();
        app().setTab('compare');
      },
    },
    {
      title: t('方案与报告'),
      body: t('把当前设置保存为方案，任选两个并排对比；连续模拟 7 到 30 天看波动范围；粗略的经营账；一键导出 HTML 报告或截图。'),
      target: '.data-pane',
      side: 'left',
      enter: () => {
        live();
        app().setTab('report');
      },
    },
    {
      title: t('门店定制'),
      body: t('画通道、旋转、多选、复制粘贴，拖动入口、电梯和暂存区；或者用门店生成器一键生成两层门店、汽车服务中心、药房。每次修改校验通过后实时应用，仿真不中断。'),
      target: '.data-pane',
      side: 'left',
      enter: () => {
        app().select(undefined);
        app().setTab('edit');
      },
    },
    {
      title: t('视角与建筑'),
      body: t('2.5D、3D、俯视三种视角；建筑可以看内部、半剖（一半外观一半店内）或完整外观。3D 视角下拖动旋转，滚轮朝光标缩放。'),
      target: '.topbar .segmented',
      side: 'below',
      enter: () => {
        leaveEdit();
        app().setTab('live');
      },
    },
    {
      title: t('语言与自动巡游'),
      body: t('顶栏上可以切换中文和英文。想放着看，就点「巡游」：镜头会自动在门店、停车场、后仓和路口之间切换，适合录演示视频。导览随时可以从「导览」按钮重新打开。'),
      target: '.tour-tools',
      side: 'below',
    },
  ];
}

/** 第一次打开时的邀请卡片 */
export function TourInvite() {
  const step = useApp((s) => s.tourStep);
  const cinematic = useApp((s) => s.cinematic);
  const [show, setShow] = useState(() => !tourSeen());
  if (!show || step !== undefined || cinematic) return null;
  const close = () => {
    markSeen();
    setShow(false);
  };
  return (
    <div className="tour-invite float-card" role="dialog" aria-label={t('导览')}>
      <strong>{t('第一次来？')}</strong>
      <p>{t('用一分钟看看模拟器能做什么，或者让镜头自动巡游。')}</p>
      <div className="row">
        <button
          className="primary"
          onClick={() => {
            close();
            useApp.getState().setTourStep(0);
          }}
        >
          {t('开始导览')}
        </button>
        <button
          onClick={() => {
            close();
            useApp.getState().setCinematic(true);
          }}
        >
          {t('自动巡游')}
        </button>
        <button className="link" onClick={close}>
          {t('不用了')}
        </button>
      </div>
    </div>
  );
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 导览的聚光框与说明卡片 */
export function Tour() {
  const step = useApp((s) => s.tourStep);
  const lang = useApp((s) => s.lang);
  const [rect, setRect] = useState<Rect | undefined>();
  const list = steps();
  const cur = step !== undefined ? list[step] : undefined;

  // 进入一步时执行它的场景动作
  useEffect(() => {
    if (step === undefined) return;
    markSeen();
    list[step]?.enter?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // 目标元素的位置（界面可能在动画或换标签，定时刷新）
  useLayoutEffect(() => {
    if (!cur?.target) {
      setRect(undefined);
      return;
    }
    const sel = cur.target;
    const update = () => {
      const el = document.querySelector(sel);
      if (!el) return setRect(undefined);
      const r = el.getBoundingClientRect();
      setRect((old) => (old && Math.abs(old.x - r.x) < 1 && Math.abs(old.y - r.y) < 1 && Math.abs(old.w - r.width) < 1 && Math.abs(old.h - r.height) < 1 ? old : { x: r.x, y: r.y, w: r.width, h: r.height }));
    };
    update();
    const id = window.setInterval(update, 250);
    return () => window.clearInterval(id);
  }, [cur?.target, step]);

  useEffect(() => {
    if (step === undefined) return;
    const onKey = (e: KeyboardEvent) => {
      const app = useApp.getState();
      if (e.key === 'Escape') app.setTourStep(undefined);
      else if (e.key === 'ArrowRight' || e.key === 'Enter') app.setTourStep(step + 1 < list.length ? step + 1 : undefined);
      else if (e.key === 'ArrowLeft' && step > 0) app.setTourStep(step - 1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [step, list.length]);

  if (step === undefined || !cur) return null;
  void lang;
  const app = useApp.getState();
  const last = step === list.length - 1;
  const pad = 6;
  // 卡片位置：目标下方 / 上方 / 左侧
  const W = 340;
  // 没有目标：放在场景右上角（左上角是点选卡片，左下角是小地图）
  const stage = document.querySelector('.stage')?.getBoundingClientRect();
  let style: React.CSSProperties = { left: Math.max(12, (stage ? stage.right : window.innerWidth) - W - 16), top: (stage?.top ?? 80) + 16, width: W };
  if (rect) {
    if (cur.side === 'left') style = { left: Math.max(12, rect.x - W - 18), top: Math.max(70, rect.y + 40), width: W };
    else if (cur.side === 'above') style = { left: Math.max(12, Math.min(window.innerWidth - W - 12, rect.x + 40)), top: Math.max(12, rect.y - 210), width: W };
    else style = { left: Math.max(12, Math.min(window.innerWidth - W - 12, rect.x)), top: rect.y + rect.h + 14, width: W };
  }
  return (
    <div className="tour-layer" aria-live="polite">
      {rect ? <div className="tour-spot" style={{ left: rect.x - pad, top: rect.y - pad, width: rect.w + 2 * pad, height: rect.h + 2 * pad }} /> : <div className="tour-dim" />}
      <div className="tour-card float-card" style={style} role="dialog" aria-label={cur.title}>
        <div className="tour-step mono">
          {step + 1} / {list.length}
        </div>
        <h3>{cur.title}</h3>
        <p>{cur.body}</p>
        <div className="row">
          <button onClick={() => app.setTourStep(step > 0 ? step - 1 : undefined)}>{step > 0 ? t('上一步') : t('退出')}</button>
          <button className="primary" onClick={() => app.setTourStep(last ? undefined : step + 1)}>
            {last ? t('完成') : t('下一步')}
          </button>
          {!last && (
            <button className="link" onClick={() => app.setTourStep(undefined)}>
              {t('跳过导览')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
