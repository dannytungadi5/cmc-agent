const mode=process.env.CMC_TEST_MODE;
global.fetch=async url=>{
 if(mode==='network')throw new Error('unsafe fixture-key-not-real');
 const u=new URL(url);
 const stamp=mode==='stale'?'2000-01-01T00:00:00Z':mode==='future'?'2100-01-01T00:00:00Z':new Date().toISOString();
 const usd={price:mode==='zero'?0:100,percent_change_1h:1,percent_change_24h:mode==='null'?null:2,percent_change_7d:3,market_cap:1000,volume_24h:20,last_updated:stamp,open:99,high:101,low:98,close:100,volume:20};
 const asset={id:1,symbol:'BTC',name:'Bitcoin',cmc_rank:1,rank:1,quote:{USD:usd},time_open:stamp};
 const eth={...asset,id:1027,symbol:'ETH',name:'Ethereum'};
 let data=u.pathname.includes('quotes/latest')?{BTC:[asset]}:[asset];
 if(mode==='full') {
  if(u.pathname.includes('cryptocurrency/quotes')||u.pathname.includes('ohlcv')) data={BTC:[asset],ETH:[eth]};
  else if(u.pathname.includes('global-metrics')) data={btc_dominance:50,eth_dominance:20,quote:{USD:{total_market_cap:1000,total_volume_24h:10}}};
  else if(u.pathname.includes('fear-and-greed')) data={value:50,value_classification:'Neutral',update_time:stamp};
  else if(u.pathname.includes('/dex/')) data=[{name:'BTC/ETH',contract_address:'0x123',quote:[{price:100,last_updated:stamp}]}];
 }
 if(mode==='empty')data=[];
 return {ok:mode!=='http',status:mode==='http'?429:200,json:async()=>{if(mode==='badjson')throw new Error('bad');return {status:{error_code:mode==='apierror'?'1006':mode==='numeric'?0:'0',credit_count:1,...(mode==='notime'?{}:{timestamp:stamp})},...(mode==='missing'?{}:{data})};}};
};
