import React from 'react';
import { Card, Typography } from 'antd';

const { Title } = Typography;

const Analytics: React.FC = () => {
  return (
    <div>
      <Card>
        <Title level={2}>數據分析</Title>
        <p>數據分析功能開發中...</p>
      </Card>
    </div>
  );
};

export default Analytics;