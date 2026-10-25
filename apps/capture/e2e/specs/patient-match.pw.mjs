/* global window */
import {test,expect} from '@playwright/test';
test.beforeEach(async ({page})=>{
  await page.clock.setFixedTime(new Date('2026-10-24T15:00:00Z'));
  await page.goto('/e2e/fixtures/patient-match.html');
  await page.getByRole('button',{name:'Match patient later',exact:true}).click();
});
for(const dateOfBirth of [null,'1980-02-03']) test(`a new patient may be confirmed with DOB ${dateOfBirth??'unknown'}`,async({page})=>{
  const dob=page.getByLabel('Date of birth (optional)',{exact:true});
  await expect(dob).not.toHaveAttribute('required');
  if(dateOfBirth) await dob.fill(dateOfBirth);
  await page.getByRole('button',{name:'Keep this as a new patient',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const requests=await page.evaluate(()=>window.matchLab.requests);
  expect(requests).toHaveLength(1);expect(requests[0].selection).toEqual({kind:'confirm_new',dateOfBirth});
});
test('same-name charts require an explicit choice after displaying both DOBs',async({page})=>{
  const choices=page.locator('.provider-match-result');await expect(choices).toHaveCount(2);
  await expect(choices.first()).toContainText('1980-01-02');await expect(choices.last()).toContainText('1985-03-04');
  expect(await page.evaluate(()=>window.matchLab.requests)).toHaveLength(0);
  await choices.last().click();
  expect(await page.evaluate(()=>window.matchLab.requests[0].selection)).toEqual({kind:'existing',patientRef:'patient_01j00000000000000000000002'});
});
test('matching can be canceled with entered DOB and no data change',async({page})=>{
  await page.getByLabel('Date of birth (optional)',{exact:true}).fill('1980-02-03');
  await page.getByRole('button',{name:'Match later',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(()=>[window.matchLab.requests.length,window.matchLab.updated.length])).toEqual([0,0]);
});
test('an unconfirmed match retries exactly the retained selection and key',async({page})=>{
  await page.evaluate(()=>{window.matchLab.failNext=true;});
  await page.getByLabel('Date of birth (optional)',{exact:true}).fill('1980-02-03');
  await page.getByRole('button',{name:'Keep this as a new patient',exact:true}).click();
  await expect(page.getByText('The match isn’t confirmed yet. Your request is retained; try again to check it.',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Match later',exact:true}).click();
  await page.getByRole('button',{name:'Match patient later',exact:true}).click();
  await page.getByRole('button',{name:'Try again',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const requests=await page.evaluate(()=>window.matchLab.requests);
  expect(requests).toHaveLength(2);expect(requests[0]).toEqual(requests[1]);
});
test('future DOB is rejected without replacing the selected synthetic identity',async({page})=>{
  await page.getByLabel('Date of birth (optional)',{exact:true}).fill('2099-01-01');
  await page.getByRole('button',{name:'Keep this as a new patient',exact:true}).click();
  await expect(page.getByText('Enter a valid date of birth from 1900 through today, or leave it blank.',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>window.matchLab.requests)).toHaveLength(0);
});
