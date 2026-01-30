import { query } from '../db/connection';

export type NotificationType = 'info' | 'warning' | 'error' | 'success';
export type NotificationCategory = 'order' | 'driver' | 'passenger' | 'system';

interface NotificationData {
  type: NotificationType;
  category: NotificationCategory;
  title: string;
  message: string;
  relatedId?: string;
  link?: string;
}

/**
 * 通知服務 - 用於系統自動產生通知
 */
class NotificationService {
  /**
   * 建立通知
   */
  async create(data: NotificationData): Promise<number | null> {
    try {
      const result = await query(
        `INSERT INTO notifications (type, category, title, message, related_id, link)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING notification_id`,
        [data.type, data.category, data.title, data.message, data.relatedId || null, data.link || null]
      );
      return result.rows[0]?.notification_id || null;
    } catch (error) {
      console.error('[NotificationService] Failed to create notification:', error);
      return null;
    }
  }

  // ========== 訂單相關通知 ==========

  /**
   * 新訂單建立通知
   */
  async notifyNewOrder(orderId: string, passengerName: string, pickupAddress: string): Promise<void> {
    await this.create({
      type: 'info',
      category: 'order',
      title: '新訂單',
      message: `乘客 ${passengerName} 從 ${pickupAddress} 發起了新的叫車請求`,
      relatedId: orderId,
      link: `/orders?search=${orderId}`
    });
  }

  /**
   * 訂單取消通知
   */
  async notifyOrderCancelled(orderId: string, reason?: string): Promise<void> {
    await this.create({
      type: 'warning',
      category: 'order',
      title: '訂單取消',
      message: `訂單 ${orderId.slice(0, 12)} 已被取消${reason ? `，原因：${reason}` : ''}`,
      relatedId: orderId,
      link: `/orders?search=${orderId}`
    });
  }

  /**
   * 訂單完成通知
   */
  async notifyOrderCompleted(orderId: string, fare: number): Promise<void> {
    await this.create({
      type: 'success',
      category: 'order',
      title: '訂單完成',
      message: `訂單 ${orderId.slice(0, 12)} 已完成，車資 $${fare}`,
      relatedId: orderId,
      link: `/orders?search=${orderId}`
    });
  }

  /**
   * 訂單長時間未接單通知
   */
  async notifyOrderPending(orderId: string, waitingMinutes: number): Promise<void> {
    await this.create({
      type: 'warning',
      category: 'order',
      title: '訂單等待過久',
      message: `訂單 ${orderId.slice(0, 12)} 已等待 ${waitingMinutes} 分鐘仍未有司機接單`,
      relatedId: orderId,
      link: `/orders?search=${orderId}`
    });
  }

  // ========== 司機相關通知 ==========

  /**
   * 新司機註冊通知
   */
  async notifyNewDriver(driverId: string, driverName: string): Promise<void> {
    await this.create({
      type: 'info',
      category: 'driver',
      title: '新司機註冊',
      message: `司機 ${driverName} 已完成註冊`,
      relatedId: driverId,
      link: `/drivers?search=${driverName}`
    });
  }

  /**
   * 司機評分過低通知
   */
  async notifyLowRating(driverId: string, driverName: string, rating: number): Promise<void> {
    await this.create({
      type: 'warning',
      category: 'driver',
      title: '司機評分過低',
      message: `司機 ${driverName} 的評分已降至 ${rating.toFixed(1)} 星，請關注`,
      relatedId: driverId,
      link: `/drivers?search=${driverName}`
    });
  }

  /**
   * 司機長時間離線通知
   */
  async notifyDriverOffline(driverId: string, driverName: string, offlineHours: number): Promise<void> {
    await this.create({
      type: 'info',
      category: 'driver',
      title: '司機長時間離線',
      message: `司機 ${driverName} 已離線超過 ${offlineHours} 小時`,
      relatedId: driverId,
      link: `/drivers?search=${driverName}`
    });
  }

  // ========== 乘客相關通知 ==========

  /**
   * 新乘客註冊通知
   */
  async notifyNewPassenger(passengerId: string, passengerName: string): Promise<void> {
    await this.create({
      type: 'info',
      category: 'passenger',
      title: '新乘客註冊',
      message: `乘客 ${passengerName} 已完成註冊`,
      relatedId: passengerId,
      link: `/passengers?search=${passengerName}`
    });
  }

  /**
   * 新評價通知
   */
  async notifyNewRating(rating: number, count: number): Promise<void> {
    await this.create({
      type: 'success',
      category: 'passenger',
      title: '新評價',
      message: `收到 ${count} 則新的 ${rating} 星評價`
    });
  }

  // ========== 系統相關通知 ==========

  /**
   * 系統警告通知
   */
  async notifySystemWarning(title: string, message: string): Promise<void> {
    await this.create({
      type: 'warning',
      category: 'system',
      title,
      message
    });
  }

  /**
   * 系統錯誤通知
   */
  async notifySystemError(title: string, message: string): Promise<void> {
    await this.create({
      type: 'error',
      category: 'system',
      title,
      message
    });
  }

  /**
   * 訂單高峰通知
   */
  async notifyPeakHours(activeOrders: number): Promise<void> {
    await this.create({
      type: 'info',
      category: 'system',
      title: '訂單高峰',
      message: `目前有 ${activeOrders} 筆訂單等待處理，建議增加司機調度`
    });
  }

  /**
   * 伺服器啟動通知
   */
  async notifyServerStarted(): Promise<void> {
    await this.create({
      type: 'success',
      category: 'system',
      title: '系統啟動',
      message: '伺服器已成功啟動'
    });
  }
}

// 單例模式
let notificationServiceInstance: NotificationService | null = null;

export function getNotificationService(): NotificationService {
  if (!notificationServiceInstance) {
    notificationServiceInstance = new NotificationService();
  }
  return notificationServiceInstance;
}

export default NotificationService;
