package cn.lingshi.familytree.service;

import cn.lingshi.familytree.dto.PageResponse;
import cn.lingshi.familytree.dto.PersonCreateRequest;
import cn.lingshi.familytree.dto.PersonResponse;
import cn.lingshi.familytree.dto.PersonUpdateRequest;

public interface PersonService {
    PersonResponse create(PersonCreateRequest request);
    PersonResponse getById(Long id);
    PageResponse<PersonResponse> list(Long familyId, String name, Integer generation, long page, long size);
    PersonResponse update(Long id, PersonUpdateRequest request);
    void softDelete(Long id);
}
