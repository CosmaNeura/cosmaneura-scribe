// Actual patient-match dialog with synthetic ports. No identity, clinical data,
// account, network, or native capture is accessed by this browser fixture.
/* global document, window */
import {mountPatientMatch} from '../../src/provider/patient-match-view.ts';
import '../../src/provider/workspace.css';
const ref = 'patient_01j00000000000000000000000';
const encounter = {appointmentRef:'appointment_01j00000000000000000000000',patientRef:ref,title:'Synthetic walk-in',
  identity:{state:'provisional',version:0,canonicalPatientRef:ref,name:'Synthetic walk-in',dateOfBirth:null}};
let pending = null;
const lab = window.matchLab = {requests:[],searches:[],updated:[],failNext:false};
const candidates = [
  {patientRef:'patient_01j00000000000000000000001',name:'Synthetic walk-in',dateOfBirth:'1980-01-02'},
  {patientRef:'patient_01j00000000000000000000002',name:'Synthetic walk-in',dateOfBirth:'1985-03-04'},
];
document.querySelector('#open').onclick = () => mountPatientMatch(document.querySelector('#match'),{
  encounter,signal:new AbortController().signal,local:()=>pending,retain:async value=>{pending=value;},
  updated:identity=>{lab.updated.push(identity);encounter.identity=identity;},
  setup:{
    patientCandidates:async (_encounter,query,dateOfBirth)=>{lab.searches.push({query,dateOfBirth});return {patients:candidates,moreResults:false,identity:encounter.identity};},
    matchPatient:async (_encounter,selection,expectedVersion,key)=>{
      lab.requests.push({selection,expectedVersion,key});
      if(lab.failNext){lab.failNext=false;throw Error('Synthetic response loss');}
      const selected=selection.kind==='existing'?candidates.find(p=>p.patientRef===selection.patientRef):null;
      return {identity:{state:selected?'matched':'confirmed',version:expectedVersion+1,canonicalPatientRef:selected?.patientRef??ref,
        name:selected?.name??encounter.title,dateOfBirth:selected?.dateOfBirth??selection.dateOfBirth??null}};
    },
  },
});
