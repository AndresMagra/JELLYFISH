import { VerifyScreen } from '@jellyfish/mobile-core';
import { LegalAcceptNotice } from '../src/components/LegalLinks';

export default function Verify() {
  return <VerifyScreen footer={<LegalAcceptNotice />} />;
}
