import { servePortRequests } from './transport';

/**
 * 桥接页面：模拟器（另一个应用）把它放在隐藏的 iframe 里，向它要一个连到同一个门店中枢的端口，
 * 这样模拟器的「门店实况」和员工端的手机画面看到的是同一家店。
 */
servePortRequests();
