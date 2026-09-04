/* eslint-disable */
import { Test, TestingModule } from '@nestjs/testing';
import { SearchService } from './search.service';
import * as child_process from 'child_process';
import * as util from 'util';

jest.mock('child_process');
jest.mock('util', () => {
  const originalUtil = jest.requireActual('util');
  return {
    ...originalUtil,
    promisify: (fn: any) => fn, // mock promisify to just return the fn
  };
});

describe('SearchService', () => {
  let service: SearchService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [SearchService],
    }).compile();

    service = module.get<SearchService>(SearchService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
