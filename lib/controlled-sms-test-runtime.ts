import { env } from 'cloudflare:workers';
import type { ControlledSmsTestConfig } from './controlled-sms-test';

type TestEnvironment = {
  ALIYUN_SMS_TEST_ENABLED?: string;
  ALIYUN_SMS_TEST_PHONE_E164?: string;
  ALIYUN_SMS_TEST_CYCLE_ID?: string;
  SMS_MODE?: string;
};

export function controlledSmsTestConfig(): ControlledSmsTestConfig {
  const settings = env as unknown as TestEnvironment;
  return {
    enabled: settings.ALIYUN_SMS_TEST_ENABLED === 'true',
    smsMode: settings.SMS_MODE || '',
    phoneE164: settings.ALIYUN_SMS_TEST_PHONE_E164 || '',
    cycleId: settings.ALIYUN_SMS_TEST_CYCLE_ID || '',
  };
}
