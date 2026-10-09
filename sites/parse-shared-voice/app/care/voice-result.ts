import type { Proposal } from './api';

export type VoiceIntent = 'clarify' | 'chat' | 'proposal' | 'correct' | 'confirm' | 'explain' | 'support_status' | 'followup_status';
export type ProposalStatus = 'pending' | 'expired' | 'replaced' | 'committed' | string | null;

const kindLabels:Record<string,string>={health_note:'Health note',medication_report:'Medicine report',measurement:'Blood pressure',preventive_task:'Care task',support_request:'Support request',followup:'Follow-up'};

export function voiceActionLabel(intent?:VoiceIntent|null,kind?:string|null,status?:ProposalStatus):string {
  if(status==='expired')return 'This review has expired';
  if(status==='replaced')return 'This proposal was replaced';
  if(status==='committed')return 'This proposal was already confirmed';
  if(status==='pending')return `${kindLabels[kind??'']??'Care update'} — review required`;
  switch(intent){
    case 'clarify':return 'Clarification needed';
    case 'explain':return 'Medicine instructions';
    case 'support_status':return 'Support request status';
    case 'followup_status':return 'Follow-up status';
    case 'confirm':return 'Review the proposal on the dashboard';
    case 'proposal':return 'No update proposed';
    default:return 'Parse’s response';
  }
}

export function isCurrentProposal(proposal:Proposal|undefined|null):proposal is Proposal {
  if(!proposal||proposal.status!=='pending')return false;
  if(!proposal.expires_at)return true;
  const expires=Date.parse(proposal.expires_at);
  return Number.isFinite(expires)&&expires>Date.now();
}
