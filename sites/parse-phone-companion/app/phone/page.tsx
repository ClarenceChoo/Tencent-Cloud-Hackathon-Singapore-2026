import PhoneCompanion from "./phone-companion";
export const dynamic="force-dynamic";
export default async function PhonePage({searchParams}:{searchParams:Promise<{room?:string}>}){
  const query=await searchParams;const roomId=/^[a-f0-9-]{36}$/.test(query.room??"")?query.room!:"";
  return <PhoneCompanion roomId={roomId}/>;
}
