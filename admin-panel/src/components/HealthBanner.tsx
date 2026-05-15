import React, { useEffect, useState } from 'react';
import { Alert, Button } from 'antd';
import { WarningOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { healthAPI } from '../services/api';

interface Props {
  /** 顯示哪幾個 check（依 id 過濾）；空陣列 = 全部 */
  filterCheckIds?: string[];
  /** 該頁面 path（match check.pages 過濾） */
  currentPagePath?: string;
}

/**
 * 在 admin 各 list 頁面頂部顯示「系統健康」warning banner
 * 自動 fetch /api/admin/health/data-integrity，過濾跟本頁相關的 check。
 */
const HealthBanner: React.FC<Props> = ({ filterCheckIds, currentPagePath }) => {
  const [issues, setIssues] = useState<Array<{ id: string; title: string; count: number; severity: string }>>([]);
  const navigate = useNavigate();

  useEffect(() => {
    healthAPI.check().then(res => {
      const allChecks = res.data.checks;
      const filtered = allChecks.filter(c => {
        if (c.count === 0) return false;
        if (filterCheckIds && filterCheckIds.length > 0) return filterCheckIds.includes(c.id);
        if (currentPagePath) return c.pages.includes(currentPagePath);
        return true;
      });
      setIssues(filtered.map(c => ({ id: c.id, title: c.title, count: c.count, severity: c.severity })));
    }).catch(() => { /* silent */ });
  }, [filterCheckIds?.join(','), currentPagePath]);

  if (issues.length === 0) return null;

  const hasHigh = issues.some(i => i.severity === 'high');
  return (
    <Alert
      type={hasHigh ? 'error' : 'warning'}
      showIcon
      icon={<WarningOutlined />}
      style={{ marginBottom: 16 }}
      message={`偵測到 ${issues.length} 類資料異常`}
      description={
        <div>
          {issues.map(i => (
            <div key={i.id}>
              • <strong>{i.title}</strong> — {i.count} 筆
            </div>
          ))}
        </div>
      }
      action={
        <Button size="small" type="primary" danger onClick={() => navigate('/health')}>
          前往健康頁清理
        </Button>
      }
    />
  );
};

export default HealthBanner;
