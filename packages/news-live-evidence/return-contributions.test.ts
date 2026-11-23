import {expect,it} from "vitest";
import {scheduleReturnContributions} from "./return-contributions.js";
it("binds every concatenated item to its actual local producer index without using completion order",()=>{
 const a={intent:{lane:"daily"},review:{status:"paused"}},b={intent:{lane:"weekly"},review:{status:"ready"}},c={intent:{lane:"monthly"},review:{status:"blocked"}},read={intent:{lane:"archive"},review:{status:"reviewed"}};
 const producers=[{value:{findings:[a,b]}},{value:{findings:[c]}}];
 const forward=scheduleReturnContributions([a,b,c,read],producers);
 expect(forward.map(row=>[row.rootPath,row.producerPath])).toEqual([
  [["schedule",0],["findings",0]],[["schedule",1],["findings",1]],[["schedule",2],["findings",0]],[["schedule",3,"review"],[]],
 ]);
 expect(scheduleReturnContributions([a,b,c,read],[...producers].reverse())).toEqual(forward);
});
it("retains all real local projection possibilities for repeated equal findings, leaving custody ambiguity to the verifier",()=>{
 const finding={intent:{lane:"daily"},review:{status:"held"}};
 const bindings=scheduleReturnContributions([finding],[{value:{findings:[finding]}},{value:{findings:[{},finding]}}]);
 expect(bindings.map(row=>row.producerPath)).toEqual([["findings",0],["findings",1]]);
 expect(bindings.every(row=>row.rootPath.join("/")==="schedule/0")).toBe(true);
});
