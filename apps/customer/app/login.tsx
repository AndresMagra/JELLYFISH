import { LoginScreen } from '@jellyfish/mobile-core';
import { LegalAcceptNotice } from '../src/components/LegalLinks';

export default function Login() {
  return <LoginScreen footer={<LegalAcceptNotice sms />} />;
}
