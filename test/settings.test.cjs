const {test}=require('node:test');
const assert=require('node:assert/strict');
const {settingsPanel}=require('../src/settings.cjs');
function harness(fail=false,fresh=false){
    let states=[],index=0,writes=[],options;
    const plugin={epoch:1,accountId:'999999999999999999',account:{session:{uid:'me'},groups:[{id:'g',name:'Friends',enabled:true}],cache:{g:{owner:'me',members:{me:true},cards:{}}}},exportMutes:(_,o)=>{options=o;return {ids:['111111111111111111'],text:'[]'};},importMutes:async(g,ids)=>{writes.push({g,ids});if(fail)throw Error('Лимит группы');return ids.length;}};
    let signIns=0,joins=0;
    if(fresh){plugin.account.session=null;plugin.account.groups=[];plugin.sync=async()=>{};plugin.save=()=>{};plugin.configure=()=>{plugin.client={config:{},signIn:async()=>{signIns++;plugin.account.session={uid:"me"};},joinGroup:async()=>{joins++;return "new-group";}};};}
    global.BdApi={React:{createElement:(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity)}),useState:init=>{const i=index++;if(!(i in states))states[i]=init;return [states[i],v=>states[i]=v];},useReducer:()=>[0,()=>{}],useRef:()=>({current:true}),useEffect:()=>{}},Webpack:{getStore:()=>({})}};
    const component=settingsPanel(plugin,text=>{if(text!=="valid-invite")throw Error("Неверное приглашение");return {code:"group-code"};}).type;
    const render=()=>{index=0;return component();};
    const nodes=(node)=>node&&typeof node==='object'?[node,...node.children.flatMap(nodes)]:[];
    const click=async label=>{const node=nodes(render()).find(n=>n.type==='button'&&n.children.includes(label));assert.ok(node,label);await node.props.onClick();};
    const fill=(label,value)=>{const item=nodes(render()).find(n=>n.type==='label'&&n.children.includes(label));assert.ok(item,label);const input=nodes(item).find(n=>n.type==='input');input.props.onChange({target:{value}});};
    return {render,nodes,click,fill,writes,get signIns(){return signIns;},get joins(){return joins;},get options(){return options;}};
}
test('direct transfer writes selected group without JSON copy or file dialog',async()=>{
    const ui=harness();await ui.click('Открыть');await ui.click('Импорт / экспорт');
    await ui.click('Добавить мои мьюты в группу');
    assert.deepEqual(ui.writes,[{g:'g',ids:['111111111111111111']}]);
    assert.deepEqual(ui.options,{includeZeroVolume:false,includeBlocked:false});
    assert.ok(ui.nodes(ui.render()).some(n=>n.props.role==='status'&&n.children.some(c=>typeof c==='string'&&c.includes('Готово!'))));
});
test('direct transfer displays backend failure without success message',async()=>{
    const ui=harness(true);await ui.click('Открыть');await ui.click('Импорт / экспорт');await ui.click('Добавить мои мьюты в группу');
    const nodes=ui.nodes(ui.render());assert.ok(nodes.some(n=>n.props.role==='alert'&&n.children.includes('Лимит группы')));
    assert.ok(!nodes.some(n=>n.children.some(c=>typeof c==='string'&&c.includes('Готово!'))));
});
test('optional zero volume and blocklist choices reach direct transfer',async()=>{
    const ui=harness();await ui.click('Открыть');await ui.click('Импорт / экспорт');
    for(let i=1;i<=2;i++){
        const switches=ui.nodes(ui.render()).filter(n=>n.props.role==='switch');
        switches[i].props.onChange({target:{checked:true}});
    }
    await ui.click('Добавить мои мьюты в группу');
    assert.deepEqual(ui.options,{includeZeroVolume:true,includeBlocked:true});
});
test('onboarding validates invite and password confirmation then joins automatically',async()=>{
    const ui=harness(false,true);
    assert.ok(!ui.nodes(ui.render()).some(n=>n.type==='input'&&n.props.type==='password'));
    ui.fill('Приглашение','bad');await ui.click('Проверить приглашение и продолжить');assert.equal(ui.signIns,0);
    ui.fill('Приглашение','valid-invite');await ui.click('Проверить приглашение и продолжить');
    ui.fill('Email','new@example.test');ui.fill('Новый пароль — минимум 6 символов','test-password');ui.fill('Повторите пароль','wrong');
    await ui.click('Создать аккаунт и продолжить');assert.equal(ui.signIns,0);
    ui.fill('Повторите пароль','test-password');await ui.click('Создать аккаунт и продолжить');assert.equal(ui.signIns,1);assert.equal(ui.joins,1);
});
